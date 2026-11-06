#!/usr/bin/env python3
"""Prepare immutable JVM/native bundles and manage only our terminal-launched process."""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]


class DemoError(Exception):
    pass


def stamp():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read_json(path):
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError('expected a JSON object')
        return value
    except (OSError, ValueError) as exc:
        raise DemoError(f'Cannot read {path}: {exc}') from exc


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def capture(args, cwd=None):
    try:
        return subprocess.check_output(args, cwd=cwd, stderr=subprocess.STDOUT, text=True).strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise DemoError(f'Command failed: {args[0]}: {getattr(exc, "output", str(exc))}') from exc


def source_hash(root):
    paths = [root / 'pom.xml', root / 'mvnw']
    for directory in ['src/main', '.mvn']:
        paths.extend(p for p in (root / directory).rglob('*') if p.is_file())
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(str(path.relative_to(root)).encode())
        digest.update(b'\0')
        digest.update(path.read_bytes())
        digest.update(b'\0')
    return digest.hexdigest()


def artifact_hash(path):
    paths = sorted(p for p in path.rglob('*') if p.is_file()) if path.is_dir() else [path]
    digest, size = hashlib.sha256(), 0
    for item in paths:
        digest.update(str(item.relative_to(path) if path.is_dir() else item.name).encode())
        digest.update(b'\0')
        with item.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
                size += len(block)
    return digest.hexdigest(), size


def peak_mib(text, system):
    if system == 'Darwin':
        match = re.search(r'(\d+)\s+maximum resident set size', text)
        return int(match[1]) / 1048576 if match else None
    if system == 'Linux':
        match = re.search(r'Maximum resident set size \(kbytes\):\s*(\d+)', text)
        return int(match[1]) / 1024 if match else None
    return None


def checked_toolchain(home):
    home = Path(home).expanduser().absolute()
    java, compiler = home / 'bin/java', home / 'bin/native-image'
    if not all(path.is_file() and os.access(path, os.X_OK) for path in [java, compiler]):
        raise DemoError(f'No complete GraalVM installation at {home}: bin/java and bin/native-image are required.')
    java_version = capture([str(java), '-version'])
    native_version = capture([str(compiler), '--version'])
    match = re.search(r'(?:openjdk|java)\s+(?:version\s+)?"?(\d+)', java_version)
    if not match or match[1] != '25' or not re.search(r'native-image\s+25(?:\.|\s|$)', native_version):
        raise DemoError('Use matching GraalVM JDK 25 java and native-image.\n' + java_version + '\n' + native_version)
    return dict(java=str(java), java_home=str(home), java_version=java_version,
                native_image=str(compiler), native_version=native_version)


class Demo:
    def __init__(self, root=ROOT):
        self.root = root.resolve()
        self.home = self.root / 'demo-artifacts'
        if self.home.is_symlink():
            raise DemoError('Refusing to manage a symlinked demo-artifacts directory.')
        self.home.mkdir(exist_ok=True)
        self.current = self.home / 'current.json'
        self.state = self.home / 'process.json'
        self.last = self.home / 'last-launch.json'
        self.children = []
        self.system = platform.system()
        self.host = f'{self.system}/{platform.machine()}'

    @contextlib.contextmanager
    def lock(self):
        with (self.home / 'command.lock').open('w') as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise DemoError('Another demo command is running. Wait for it to finish.') from exc
            yield

    def settings(self):
        try:
            port = int(os.environ.get('DEMO_PORT', '8080'))
            cpus = int(os.environ.get('DEMO_CPUS', '2'))
            if not 1 <= port <= 65535 or not 1 <= cpus <= 1024:
                raise ValueError()
        except ValueError as exc:
            raise DemoError('DEMO_PORT must be 1–65535; DEMO_CPUS must be 1–1024.') from exc
        xms, xmx = os.environ.get('DEMO_XMS', '64m'), os.environ.get('DEMO_XMX', '256m')
        if not all(re.fullmatch(r'[1-9][0-9]*[kKmMgG]', v) for v in [xms, xmx]):
            raise DemoError('DEMO_XMS and DEMO_XMX must be sizes such as 64m and 256m.')
        return dict(port=port, cpus=cpus, xms=xms, xmx=xmx)

    def process(self):
        if not self.state.exists():
            return None
        state = read_json(self.state)
        pid, token = state.get('pid'), state.get('token')
        if not isinstance(pid, int) or pid <= 1 or not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{32}', token):
            raise DemoError('Invalid process record; refusing to signal any process.')
        try:
            args = capture(['ps', '-ww', '-p', str(pid), '-o', 'stat=', '-o', 'args='])
        except DemoError:
            # A missing PID is stale; a live but uninspectable PID must never be signaled.
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return None
            except PermissionError:
                pass
            raise DemoError(f'Cannot verify process {pid}; refusing to manage it.')
        if args.split() and args.split()[0].startswith('Z'):
            return None
        if f'-Ddemo.launch.id={token}' not in args.split():
            if '<defunct>' in args or '(defunct)' in args:
                return None
            raise DemoError(f'PID {pid} no longer belongs to this demo; refusing to signal it.')
        return state

    def port_free(self, port):
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(('127.0.0.1', port))
            except OSError as exc:
                raise DemoError(f'Port {port} is occupied. Stop dev mode or the other process first; no process was killed.') from exc

    def no_dev_mode(self):
        args = capture(['ps', '-ww', '-axo', 'args='])
        for line in args.splitlines():
            if str(self.root) in line and any(term in line for term in ['quarkus:dev', 'DevModeMain', 'QuarkusDevModeTest', '-dev.jar']):
                raise DemoError('Quarkus dev mode is running for this checkout. Stop it before packaging (MCP: quarkus_stop).')

    def bundle(self, required=True):
        if not self.current.exists():
            if required:
                raise DemoError('No prepared pair. Run ./demo.sh prepare before the talk, or ./demo.sh up.')
            return None
        manifest = read_json(self.current)
        if manifest.get('version') != 1:
            raise DemoError('Unsupported bundle manifest; run ./demo.sh prepare --force.')
        directory = self.home / manifest.get('bundle', '')
        if directory.parent != self.home / 'builds' or not directory.is_dir():
            raise DemoError('Invalid or missing prepared bundle; run ./demo.sh prepare --force.')
        if manifest.get('host') != self.host or manifest.get('source_hash') != source_hash(self.root):
            if required:
                raise DemoError('Prepared artifacts are stale or for a different host. Run ./demo.sh prepare.')
            return None
        for runtime, relative in [('jvm', 'jvm/quarkus-app'), ('native', 'native/app')]:
            path = directory / relative
            if not path.exists() or artifact_hash(path)[0] != manifest.get('digests', {}).get(runtime):
                if required:
                    raise DemoError(f'{runtime} artifact missing or changed; run ./demo.sh prepare --force.')
                return None
        return manifest

    def toolchain(self):
        # Explicit GraalVM configuration wins; JAVA_HOME may be a separate Temurin JDK.
        if os.environ.get('GRAALVM_HOME'):
            return checked_toolchain(os.environ['GRAALVM_HOME'])
        java_home = os.environ.get('JAVA_HOME')
        if java_home and (Path(java_home).expanduser() / 'bin/native-image').is_file():
            return checked_toolchain(java_home)
        compiler = shutil.which('native-image')
        failures = []
        if compiler:
            # A PATH entry can be a symlink into lib/svm/bin. Find its JDK root.
            for location in [Path(compiler).absolute(), Path(compiler).resolve()]:
                for home in location.parents:
                    if (home / 'bin/java').is_file() and (home / 'bin/native-image').is_file():
                        try:
                            return checked_toolchain(home)
                        except DemoError as exc:
                            failures.append(str(exc))
                            break
        sdkman = Path(os.environ.get('SDKMAN_CANDIDATES_DIR') or
                      str(Path(os.environ.get('SDKMAN_DIR') or str(Path.home() / '.sdkman')) / 'candidates')) / 'java'
        current = sdkman / 'current'
        if (current / 'bin/native-image').is_file():
            try:
                return checked_toolchain(current.resolve())
            except DemoError:
                pass
        compatible = {}
        if sdkman.is_dir():
            for home in sorted(sdkman.iterdir()):
                if home.name == 'current' or not (home / 'bin/native-image').is_file():
                    continue
                try:
                    tools = checked_toolchain(home.resolve())
                    compatible[tools['java_home']] = tools
                except DemoError as exc:
                    failures.append(str(exc))
        if len(compatible) == 1:
            return next(iter(compatible.values()))
        if len(compatible) > 1:
            raise DemoError('Multiple GraalVM JDK 25 installations found. Set GRAALVM_HOME to one of:\n' + '\n'.join(compatible))
        details = '\n' + '\n'.join(failures) if failures else ''
        raise DemoError('GraalVM JDK 25 could not be located. Set GRAALVM_HOME or JAVA_HOME to its installation directory. '
                        f'Also checked PATH and {sdkman}.{details}')

    def build(self, runtime, directory):
        costs = directory / 'costs'
        costs.mkdir(exist_ok=True)
        args = [str(self.root / 'mvnw'), 'package', '-DskipTests']
        if runtime == 'jvm':
            args += ['-Dquarkus.package.jar.type=fast-jar', '-Dquarkus.package.jar.enabled=true']
        if runtime == 'native':
            args += ['-Dnative', '-Dquarkus.native.container-build=false']
        # Explicitly suppress image creation/deployment: these are local artifacts.
        args += ['-Dquarkus.container-image.build=false', '-Dquarkus.container-image.push=false']
        timing = Path('/usr/bin/time')
        timed = timing.is_file() and self.system in ['Darwin', 'Linux']
        command = [str(timing), '-lp' if self.system == 'Darwin' else '-v'] + args if timed else args
        stdout, stderr = costs / f'{runtime}-build.stdout', costs / f'{runtime}-build.stderr'
        print(f'Building {runtime}; log: {stdout}', flush=True)
        started, start = stamp(), time.perf_counter()
        with stdout.open('w') as out, stderr.open('w') as err:
            result = subprocess.run(command, cwd=self.root, stdout=out, stderr=err, check=False)
        elapsed = time.perf_counter() - start
        if result.returncode:
            raise DemoError(f'{runtime} build failed ({result.returncode}). See {stdout} and {stderr}. Previous prepared pair is unchanged.')
        if runtime == 'jvm':
            src, destination = self.root / 'target/quarkus-app', directory / 'jvm/quarkus-app'
            if not (src / 'quarkus-run.jar').is_file():
                raise DemoError('Build did not produce target/quarkus-app/quarkus-run.jar.')
            shutil.copytree(src, destination)
        else:
            src, destination = self.root / 'target/high-perf-kube-java-1.0.0-SNAPSHOT-runner', directory / 'native/app'
            if not src.is_file() or not os.access(src, os.X_OK):
                raise DemoError(f'Native executable not produced: {src}')
            destination.parent.mkdir(parents=True)
            shutil.copy2(src, destination)
        digest, size = artifact_hash(destination)
        cost = dict(build_seconds=elapsed, peak_build_mib=peak_mib(stderr.read_text(), self.system) if timed else None,
                    artifact_bytes=size, image_bytes=None, timestamp=started,
                    source=str(stderr.relative_to(self.root)),
                    memory_boundary='maximum RSS reported by host time for the build command; not container-wide memory',
                    command=args)
        write_json(costs / f'{runtime}.json', cost)
        return digest

    def prepare(self, force=False):
        if not force:
            existing = self.bundle(required=False)
            if existing:
                print(f'Reusing prepared pair: {existing["bundle"]}')
                return existing
        if self.process():
            raise DemoError('Stop the managed demo with ./demo.sh down before rebuilding.')
        self.no_dev_mode()
        tools = self.toolchain()
        before = source_hash(self.root)
        revision = capture(['git', 'rev-parse', 'HEAD'], self.root)
        dirty = bool(capture(['git', 'status', '--porcelain'], self.root))
        directory = self.home / 'builds' / (dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8])
        directory.mkdir(parents=True)
        # Pin Maven's JDK and native compiler to the checked toolchain, even if PATH differs.
        old_homes = {key: os.environ.get(key) for key in ['JAVA_HOME', 'GRAALVM_HOME']}
        for key in old_homes:
            os.environ[key] = tools['java_home']
        try:
            digests = {runtime: self.build(runtime, directory) for runtime in ['jvm', 'native']}
        finally:
            for key, value in old_homes.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        if before != source_hash(self.root):
            raise DemoError('Sources changed during the build; pair was not published. Run prepare again.')
        manifest = dict(version=1, bundle=str(directory.relative_to(self.home)), source_hash=before,
                        revision=revision, dirty=dirty, host=self.host, timestamp=stamp(), toolchain=tools, digests=digests)
        write_json(directory / 'manifest.json', manifest)
        write_json(self.current, manifest)
        print(f'Prepared both artifacts: {directory}\nSource: {revision}{" (dirty checkout)" if dirty else ""}')
        return manifest

    def get(self, port, path):
        # Ignore proxy settings for loopback requests. Never call a benchmark here.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f'http://127.0.0.1:{port}{path}', timeout=2) as response:
            return json.load(response)

    def ready(self, state):
        info = self.get(state['settings']['port'], '/perf/info')
        expected = 'native-image' if state['runtime'] == 'native' else 'jvm'
        if info.get('runtime_type') != expected or not info.get('process_id'):
            raise DemoError('Runtime identity did not match the launched artifact.')
        health = self.get(state['settings']['port'], '/q/health/ready')
        if health.get('status') != 'UP':
            raise DemoError('Readiness endpoint is not UP.')
        return info

    def start(self, runtime, manifest, settings):
        self.port_free(settings['port'])
        directory = self.home / manifest['bundle']
        token = uuid.uuid4().hex
        evidence_dir = self.home / 'evidence'
        evidence_dir.mkdir(exist_ok=True)
        evidence_path = evidence_dir / f'{token}.json'
        flags = [f'-Xms{settings["xms"]}', f'-Xmx{settings["xmx"]}', f'-XX:ActiveProcessorCount={settings["cpus"]}',
                 f'-Dquarkus.http.port={settings["port"]}', '-Dquarkus.http.host=127.0.0.1', f'-Ddemo.launch.id={token}', f'-Ddemo.evidence.path={evidence_path}']
        args = [manifest['toolchain']['java']] + flags + ['-jar', str(directory / 'jvm/quarkus-app/quarkus-run.jar')] if runtime == 'jvm' else [str(directory / 'native/app')] + flags
        log_dir = self.home / 'logs'
        log_dir.mkdir(exist_ok=True)
        log = log_dir / f'{runtime}-{token[:8]}.log'
        print(f'Starting packaged {runtime}; waiting up to 60 s for readiness. Log: {log}', flush=True)
        launch_start = time.perf_counter()
        with log.open('w') as stream:
            child = subprocess.Popen(args, cwd=self.root, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        self.children.append(child)
        state = dict(pid=child.pid, token=token, runtime=runtime, settings=settings, bundle=manifest['bundle'],
                     started_at=stamp(), log=str(log.relative_to(self.root)), command=args)
        try:
            write_json(self.state, state)
            write_json(self.last, dict(log=state['log'], runtime=runtime, started_at=state['started_at']))
            deadline, last_error = time.monotonic() + 60, 'not yet reachable'
            while time.monotonic() < deadline:
                if child.poll() is not None:
                    raise DemoError(f'{runtime} exited with code {child.returncode}; see {log}')
                try:
                    info = self.ready(state)
                    if info.get('available_processors') != settings['cpus']:
                        raise DemoError('Runtime processor count differs from DEMO_CPUS; check the runtime flags.')
                    state['process_id'] = info['process_id']
                    observed_ms = (time.perf_counter() - launch_start) * 1000
                    costs_path = directory / 'costs' / f'{runtime}.json'
                    costs = read_json(costs_path) if costs_path.exists() else {}
                    evidence = dict(version=1, process_id=info['process_id'], runtime=runtime,
                                    revision=manifest['revision'], source_hash=manifest['source_hash'],
                                    dirty=manifest['dirty'], collected_at=stamp(), costs=costs,
                                    environment_mode='host', image_status='not-applicable: no container image built',
                                    settings=dict(cpu=f'ActiveProcessorCount={settings["cpus"]}; no OS quota set by demo.sh',
                                                  heap=f'-Xms{settings["xms"]} -Xmx{settings["xmx"]}',
                                                  memory='none set by demo.sh (host run)',
                                                  flags=' '.join(flag for flag in flags if not flag.startswith(('-Ddemo.launch.id=', '-Ddemo.evidence.path='))),
                                                  environment=platform.platform() + ' / ' + platform.machine()),
                                    launch=dict(duration_ms=observed_ms, source='demo.sh monotonic clock: before Popen to successful info + readiness checks',
                                                timestamp=stamp(), polling_interval_ms=50,
                                                boundary='terminal launch to observed readiness, includes process creation and polling; not Kubernetes readiness'))
                    write_json(evidence_path, evidence)
                    write_json(self.state, state)
                    print(f'{runtime} ready at http://localhost:{settings["port"]}\nPID {child.pid}; log: {log}\nSource: {manifest["revision"]}{" (dirty checkout)" if manifest["dirty"] else ""}')
                    print('Keep the SPA open. Use ./demo.sh switch for the other prepared runtime.')
                    return
                except (OSError, ValueError, DemoError, urllib.error.URLError) as exc:
                    last_error = str(exc)
                time.sleep(0.05)
            raise DemoError(f'Readiness timed out: {last_error}. See {log}')
        except BaseException:
            # This child was created in this invocation, so its ownership is certain.
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            self.state.unlink(missing_ok=True)
            raise

    def down(self):
        state = self.process()
        if not state:
            self.state.unlink(missing_ok=True)
            print('Demo is already stopped.')
            return
        os.kill(state['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            for child in self.children:
                child.poll()
            if not self.process():
                for child in self.children:
                    if child.pid == state['pid']:
                        child.wait(timeout=1)
                self.state.unlink(missing_ok=True)
                print(f'Stopped {state["runtime"]}. Prepared artifacts and browser sessions are preserved.')
                return
            time.sleep(0.2)
        raise DemoError('Process has not exited after SIGTERM. Inspect its log; no force kill was sent.')

    def up(self, runtime='jvm'):
        settings = self.settings()
        state = self.process()
        if state:
            manifest = self.bundle()
            if state['runtime'] != runtime or state['settings'] != settings or state['bundle'] != manifest['bundle']:
                raise DemoError('A different runtime, artifact or configuration is running. Use switch, or down then up.')
            self.ready(state)
            print(f'Already running {runtime} at http://localhost:{settings["port"]}')
            return
        self.port_free(settings['port'])
        manifest = self.prepare()
        self.start(runtime, manifest, settings)

    def switch(self, runtime=None):
        state = self.process()
        if not state:
            raise DemoError('No managed runtime is running. Start with ./demo.sh up.')
        manifest = self.bundle()  # Validate both artifacts before stopping anything.
        runtime = runtime or ('native' if state['runtime'] == 'jvm' else 'jvm')
        if runtime == state['runtime']:
            print(f'Already running {runtime}.')
            return
        settings = state['settings']  # Preserve exact port/heap/CPU declarations.
        self.down()
        print('Backend stopped; allowing the open SPA to observe disconnection.', flush=True)
        time.sleep(2)
        self.start(runtime, manifest, settings)

    def reset(self):
        # Keep the lock inode: replacing it would let a concurrent command bypass flock.
        self.no_dev_mode()
        self.down()
        paths = [p for p in self.home.iterdir() if p.name != 'command.lock']
        paths.append(self.root / 'target')
        for path in paths:
            if path.is_symlink() or path.is_file():
                path.unlink()
            elif path.is_dir():
                shutil.rmtree(path)
        print('Reset complete: prepared bundles, evidence, logs and target/ removed.')
        print('Browser sessions are separate: use Reset comparison session in the SPA to clear saved results.')

    def status(self):
        state = self.process()
        if not state:
            print('Stopped. Run ./demo.sh up.')
            return
        try:
            info = self.ready(state)
            print(f'{state["runtime"]}: UP at http://localhost:{state["settings"]["port"]}; process {info["process_id"]}')
        except (OSError, ValueError, DemoError, urllib.error.URLError) as exc:
            raise DemoError(f'PID {state["pid"]} exists but endpoint is unavailable: {exc}') from exc
        print(json.dumps(state, indent=2))

    def costs(self):
        manifest = self.bundle()
        directory = self.home / manifest['bundle']
        print(json.dumps(dict(manifest=manifest, costs={r: read_json(directory / 'costs' / f'{r}.json') for r in ['jvm', 'native']}), indent=2))

    def logs(self):
        record = self.state if self.state.exists() else self.last
        if not record.exists():
            raise DemoError('No launch log yet. Start with ./demo.sh up.')
        path = self.root / read_json(record)['log']
        print(f'Last 80 lines of {path}:')
        print('\n'.join(path.read_text(errors='replace').splitlines()[-80:]))


def main():
    parser = argparse.ArgumentParser(prog='./demo.sh', description='Prebuild both runtimes once; launch and switch packaged artifacts on one port.')
    subs = parser.add_subparsers(dest='command', required=True)
    prepare = subs.add_parser('prepare', help='Build missing/stale JVM and native artifacts; do not start')
    prepare.add_argument('--force', action='store_true', help='Create a fresh bundle even when sources match')
    up = subs.add_parser('up', help='Prepare if needed, then start packaged JVM (or native)')
    up.add_argument('runtime', choices=['jvm', 'native'], nargs='?', default='jvm')
    switch = subs.add_parser('switch', help='Switch to the other prepared runtime, preserving settings')
    switch.add_argument('runtime', choices=['jvm', 'native'], nargs='?')
    for command, help_text in [('down', 'Stop only the script-owned runtime'), ('status', 'Show runtime, health and launch settings'), ('logs', 'Print the last 80 log lines'), ('costs', 'Print measured build costs and provenance'), ('reset', 'Stop managed demo and remove demo artifacts plus target/')]:
        subs.add_parser(command, help=help_text)
    args = parser.parse_args()
    if sys.version_info < (3, 9) or platform.system() not in ['Darwin', 'Linux']:
        parser.error('Requires Python 3.9+ on macOS or Linux.')
    try:
        demo = Demo()
        with demo.lock():
            if args.command == 'prepare':
                demo.prepare(args.force)
            elif args.command in ['up', 'switch']:
                getattr(demo, args.command)(args.runtime)
            else:
                getattr(demo, args.command)()
    except (DemoError, OSError, KeyboardInterrupt) as exc:
        print(f'demo: {str(exc) or "interrupted"}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
