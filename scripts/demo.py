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
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_IMAGE = 'quay.io/danieloh30/high-perf-java:1.0'
DEFAULT_DEPLOYMENT = 'high-perf-java'


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
                                    reset_generation=read_json(self.home / 'reset-generation.json')['id'] if (self.home / 'reset-generation.json').exists() else 'initial',
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

    def image(self, image, platform_name, push=False):
        # Jib is the builder. Podman is used only for the local image load/inspection.
        if not re.fullmatch(r'[a-z0-9.-]+(?::[0-9]+)?/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*/)*[a-z0-9]+(?:[._-][a-z0-9]+)*:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', image):
            raise DemoError('Use a tagged image reference, e.g. quay.io/danieloh30/high-perf-java:1.0, not a registry web-page URL.')
        if platform_name not in ['linux/amd64', 'linux/arm64']:
            raise DemoError('Choose linux/amd64 or linux/arm64 to match the target cluster or Podman machine.')
        tools = self.toolchain()
        podman = shutil.which('podman')
        if not push:
            if not podman:
                raise DemoError('Local Jib image loading requires Podman. Use --push for a registry-only build without a local daemon.')
            check = subprocess.run([podman, 'info'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            if check.returncode:
                raise DemoError('Podman is not ready. Start its machine first, or use --push with registry credentials configured.')
        before = source_hash(self.root)
        directory = self.home / 'images' / (dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8])
        source = directory / 'source'
        source.mkdir(parents=True)
        for name in ['pom.xml', 'mvnw']:
            shutil.copy2(self.root / name, source / name)
        for name in ['.mvn', 'src/main']:
            if (self.root / name).exists():
                shutil.copytree(self.root / name, source / name)
        args = [str(source / 'mvnw'), 'package', '-DskipTests', '-P!native',
                '-Dquarkus.native.enabled=false', '-Dquarkus.package.jar.enabled=true',
                '-Dquarkus.package.jar.type=fast-jar', '-Dquarkus.container-image.builder=jib',
                '-Dquarkus.container-image.build=true', f'-Dquarkus.container-image.push={str(push).lower()}',
                f'-Dquarkus.container-image.image={image}', f'-Dquarkus.jib.platforms={platform_name}',
                '-Dquarkus.http.cors.enabled=true', '-Dquarkus.http.cors.origins=http://localhost:8080,http://127.0.0.1:8080']
        if not push:
            args.append(f'-Dquarkus.jib.docker-executable-name={podman}')
        base = os.environ.get('DEMO_JIB_BASE_IMAGE')
        if base:
            args.append(f'-Dquarkus.jib.base-jvm-image={base}')
        origins=os.environ.get('DEMO_DASHBOARD_ORIGINS',f'http://localhost:{self.settings()["port"]},http://127.0.0.1:{self.settings()["port"]}')
        for origin in origins.split(','):
            parsed=urllib.parse.urlsplit(origin)
            if parsed.scheme not in ['http','https'] or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ['', '/']:
                raise DemoError('DEMO_DASHBOARD_ORIGINS must contain explicit http(s) origins, without credentials or paths.')
        args=[a for a in args if not a.startswith('-Dquarkus.http.cors.origins=')]+[f'-Dquarkus.http.cors.origins={origins}']
        env = dict(os.environ, JAVA_HOME=tools['java_home'])
        log = directory / 'jib-build.log'
        timestamp, start = stamp(), time.perf_counter()
        print(f'Building JVM container with quarkus-container-image-jib ({platform_name}). Log: {log}', flush=True)
        with log.open('w') as stream:
            result = subprocess.run(args, cwd=source, env=env, stdout=stream, stderr=subprocess.STDOUT, check=False)
        elapsed = time.perf_counter() - start
        if result.returncode:
            raise DemoError(f'Jib image build failed ({result.returncode}); see {log}. Prepared host artifacts are unchanged.')
        if source_hash(self.root) != before:
            raise DemoError('Sources changed while building the image; receipt not published. Rebuild before using it in the presentation.')
        digest_path = source / 'target/jib-image.digest'
        digest = digest_path.read_text().strip() if digest_path.exists() else ''
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
            raise DemoError(f'Jib did not produce a valid image digest. Inspect {log}; no successful image receipt was published.')
        size, size_source = None, 'not collected: registry-only push; local uncompressed image size was not inspected'
        if not push:
            try:
                inspected = json.loads(capture([podman, 'image', 'inspect', image]))
                value = inspected[0].get('Size') if isinstance(inspected, list) and inspected else None
                if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                    size, size_source = value, 'podman image inspect Size: local image bytes, not compressed registry transfer bytes'
            except (DemoError, ValueError):
                size_source = 'not collected: local image inspection failed'
        receipt = dict(version=1, builder='quarkus-container-image-jib', runtime='jvm', image=image,
                       digest=digest, platform=platform_name, published=push, local=not push, dashboard_origins=origins,
                       image_bytes=size, image_size_source=size_source, build_seconds=elapsed,
                       source_hash=before, revision=capture(['git', 'rev-parse', 'HEAD'], self.root),
                       timestamp=timestamp, source=str(log.relative_to(self.root)), command=args)
        write_json(directory / 'receipt.json', receipt)
        write_json(self.home / 'images/latest.json', receipt)
        print(json.dumps(receipt, indent=2))
        if push:
            print('Registry push completed. Copy the image reference/digest into the OpenShift console.')
        else:
            print('Jib build completed and loaded into Podman. Optional functional check: podman run --rm -p 127.0.0.1:8082:8080 ' + image)
        return receipt

    def scale(self, namespace, deployment, replicas, timeout_seconds=300):
        if not re.fullmatch(r'[a-z0-9](?:[-a-z0-9]*[a-z0-9])?',namespace) or not re.fullmatch(r'[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?',deployment):
            raise DemoError('Use explicit valid namespace and Deployment names.')
        if not 0 <= replicas <= 100 or not 1 <= timeout_seconds <= 3600:
            raise DemoError('Replicas must be 0–100; timeout must be 1–3600 seconds.')
        oc = shutil.which('oc')
        if not oc:
            raise DemoError('oc is required; log into your prepared OpenShift cluster before scaling.')
        def call(*args):
            try:
                result = subprocess.run([oc,*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=15)
            except subprocess.TimeoutExpired as exc:
                raise DemoError('OpenShift API command timed out.') from exc
            if result.returncode:
                raise DemoError(result.stderr.strip() or 'OpenShift API command failed.')
            return result.stdout
        def resource(kind,name=None,selector=None):
            args=['-n',namespace,'get',kind]
            if name:args.append(name)
            if selector:args+=['-l',selector]
            return json.loads(call(*args,'-o','json'))
        initial=resource('deployment',deployment)
        uid=initial['metadata']['uid']
        labels=initial['spec']['selector'].get('matchLabels',{})
        if not labels or initial['spec']['selector'].get('matchExpressions'):
            raise DemoError('This observer requires a Deployment with a nonempty matchLabels selector and no matchExpressions.')
        selector=','.join(f'{k}={v}' for k,v in sorted(labels.items()))
        template=json.dumps(initial['spec']['template'],sort_keys=True)
        original=initial['spec'].get('replicas',1)
        directory=self.home/'scales';directory.mkdir(exist_ok=True)
        path=directory/(dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ-')+uuid.uuid4().hex[:8]+'.json')
        record=dict(version=1,kind='scale',status='observing',namespace=namespace,deployment=deployment,
                    deployment_uid=uid,from_replicas=original,target=replicas,timestamp=stamp(),
                    source='oc scale + oc get deployment/replicasets/pods, current authenticated CLI context',
                    context=call('config','current-context').strip(),poll_interval_ms=2000,
                    boundary='before oc scale request to observed Ready + Available target and excess owned pods terminated; includes API latency and polling',
                    images=[dict(name=c.get('name'),image=c.get('image'),resources=c.get('resources',{})) for c in initial['spec']['template']['spec']['containers']],timeline=[],duration_ms=None)
        def publish():
            write_json(path,record);write_json(directory/'latest.json',record)
        if original==replicas:
            record['status']='already-at-target';record['reason']='No scale change requested; not a scale-time measurement.';publish();print(json.dumps(record,indent=2));return record
        start=time.perf_counter()
        try:
            print(f'Scaling Deployment {namespace}/{deployment}: {original} → {replicas}. Observation: {path}',flush=True)
            call('-n',namespace,'scale','deployment/'+deployment,'--replicas='+str(replicas))
            while True:
                current=resource('deployment',deployment)
                if current['metadata']['uid']!=uid or json.dumps(current['spec']['template'],sort_keys=True)!=template:
                    raise DemoError('Deployment identity or pod template changed during observation; scale comparison invalid.')
                if current['spec'].get('replicas')!=replicas:
                    raise DemoError('Another actor changed desired replicas during observation.')
                replica_sets=resource('replicasets',selector=selector).get('items',[])
                owned={r['metadata']['uid'] for r in replica_sets if any(o.get('uid')==uid for o in r['metadata'].get('ownerReferences',[]))}
                pods=[p for p in resource('pods',selector=selector).get('items',[]) if any(o.get('uid') in owned for o in p['metadata'].get('ownerReferences',[]))]
                status=current.get('status',{})
                row=dict(elapsed_ms=(time.perf_counter()-start)*1000,observed_at=stamp(),
                         ready=status.get('readyReplicas',0),available=status.get('availableReplicas',0),
                         updated=status.get('updatedReplicas',0),replicas=status.get('replicas',0),
                         owned_pods=len(pods),ready_pods=sum(any(c.get('type')=='Ready' and c.get('status')=='True' for c in p.get('status',{}).get('conditions',[])) for p in pods),
                         terminating=sum(bool(p['metadata'].get('deletionTimestamp')) for p in pods),
                         pending=sum(p.get('status',{}).get('phase')=='Pending' for p in pods))
                record['timeline'].append(row)
                complete=all(row[k]==replicas for k in ['ready','available','updated','replicas','owned_pods','ready_pods']) and row['terminating']==0 and status.get('observedGeneration',0)>=current['metadata'].get('generation',0)
                print(f'{row["elapsed_ms"]/1000:.1f}s: Ready {row["ready"]}/{replicas}, Available {row["available"]}, Pending {row["pending"]}, Terminating {row["terminating"]}',flush=True)
                if complete:
                    record['status']='complete';record['duration_ms']=row['elapsed_ms'];publish();return record
                if row['elapsed_ms']>=timeout_seconds*1000:
                    record['status']='timed-out';record['reason']='Target not observed within timeout; this is not a successful zero-duration result.';publish();raise DemoError('Scale observation timed out. Desired replicas remain changed; inspect scheduling, image pulls, probes and quota in the console.')
                publish();time.sleep(2)
        except KeyboardInterrupt:
            record['status']='cancelled';record['reason']='Observer interrupted; desired replica count was not rolled back.';publish();raise
        except (DemoError,ValueError,KeyError) as exc:
            if record['status']!='timed-out':record['status']='failed';record['reason']=str(exc)
            publish();raise DemoError(f'{exc} Observation saved to {path}') from exc

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
        write_json(self.home / 'reset-generation.json', dict(id=uuid.uuid4().hex, reset_at=stamp()))
        print('Reset complete: prepared bundles, evidence, logs and target/ removed.')
        print('The next launch will also clear the connected browser comparison. Export saved results before reset if needed.')

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
    prepare.add_argument('--image', default=os.environ.get('DEMO_IMAGE', DEFAULT_IMAGE), help='JVM image to build with Quarkus Jib (default: %(default)s)')
    prepare.add_argument('--no-image', action='store_true', help='Prepare only the host JVM/native pair; skip the image build and push')
    prepare.add_argument('--push-image', action=argparse.BooleanOptionalAction, default=True, help='Push directly with Jib (default); --no-push-image loads locally with Podman')
    prepare.add_argument('--platform', dest='platform_name', choices=['linux/amd64','linux/arm64'], default='linux/amd64')
    prepare.add_argument('--force', action='store_true', help='Create a fresh bundle even when sources match')
    up = subs.add_parser('up', help='Prepare if needed, then start packaged JVM (or native)')
    up.add_argument('runtime', choices=['jvm', 'native'], nargs='?', default='jvm')
    switch = subs.add_parser('switch', help='Switch to the other prepared runtime, preserving settings')
    switch.add_argument('runtime', choices=['jvm', 'native'], nargs='?')
    scale = subs.add_parser('scale', help='Scale an explicitly named OpenShift Deployment and record Ready/Available convergence')
    scale.add_argument('replica_count', type=int, nargs='?', help='Target replicas, e.g. scale 100 or scale 1')
    scale.add_argument('--namespace', default=DEFAULT_DEPLOYMENT, help='Namespace (default: %(default)s)')
    scale.add_argument('--deployment', default=DEFAULT_DEPLOYMENT, help='Deployment (default: %(default)s)')
    scale.add_argument('--replicas', type=int, help='Alternative to the positional replica count')
    scale.add_argument('--timeout', dest='timeout_seconds', type=int, default=300)
    image = subs.add_parser('image', help='Build a JVM image with the installed Quarkus Jib extension; isolated from host artifacts')
    image.add_argument('--image', default=os.environ.get('DEMO_IMAGE', DEFAULT_IMAGE))
    image.add_argument('--platform', dest='platform_name', choices=['linux/amd64', 'linux/arm64'], default='linux/amd64')
    image.add_argument('--push', action='store_true', help='Push directly with Jib; no local Podman load (registry credentials required)')
    for command, help_text in [('down', 'Stop only the script-owned runtime'), ('status', 'Show runtime, health and launch settings'), ('logs', 'Print the last 80 log lines'), ('costs', 'Print measured build costs and provenance'), ('reset', 'Stop managed demo and remove demo artifacts plus target/')]:
        subs.add_parser(command, help=help_text)
    args = parser.parse_args()
    if args.command == 'scale':
        if args.replica_count is not None and args.replicas is not None:
            parser.error('Use either scale COUNT or scale --replicas COUNT, not both.')
        args.replicas = args.replica_count if args.replica_count is not None else args.replicas
        if args.replicas is None:
            parser.error('Specify a target, e.g. ./demo.sh scale 100 or ./demo.sh scale 1.')
    if sys.version_info < (3, 9) or platform.system() not in ['Darwin', 'Linux']:
        parser.error('Requires Python 3.9+ on macOS or Linux.')
    try:
        demo = Demo()
        with demo.lock():
            if args.command == 'prepare':
                demo.prepare(args.force)
                if not args.no_image:
                    demo.image(args.image,args.platform_name,args.push_image)
            elif args.command == 'scale':
                demo.scale(args.namespace,args.deployment,args.replicas,args.timeout_seconds)
            elif args.command == 'image':
                demo.image(args.image, args.platform_name, args.push)
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
