"""Terminal orchestration tests. Fake build/runtime programs live only in temp dirs."""
import contextlib
import io
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('demo', Path(__file__).resolve().parents[1] / 'scripts/demo.py')
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)

# Both launchers use the same test server, accepting the real script's JVM/native flags.
SERVER = '''#!/usr/bin/env python3
import json,sys
from http.server import BaseHTTPRequestHandler,HTTPServer
if '-version' in sys.argv:
    print('openjdk version "25.0.1" TEST ONLY');sys.exit()
if '--version' in sys.argv:
    print('native-image 25.0.1 TEST ONLY');sys.exit()
if __import__('os').environ.get('FAIL_LAUNCH'):
    print('TEST ONLY launch failure',flush=True);sys.exit(7)
port=int(next(x.split('=')[1] for x in sys.argv if x.startswith('-Dquarkus.http.port=')))
runtime='jvm' if '-jar' in sys.argv else 'native-image'
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ['/perf/info','/q/health/ready']:
            self.send_response(500);self.end_headers();return
        data={'runtime_type':runtime,'process_id':'test-'+str(__import__('os').getpid()),'available_processors':2} if self.path=='/perf/info' else {'status':'UP'}
        self.send_response(200);self.end_headers();self.wfile.write(json.dumps(data).encode())
    def log_message(self,*args):pass
HTTPServer.allow_reuse_address=True
HTTPServer(('127.0.0.1',port),Handler).serve_forever()
'''
BUILD = '''#!/usr/bin/env python3
from pathlib import Path
import os,sys
p=Path('target');p.mkdir(exist_ok=True)
with Path('build-calls').open('a') as f:f.write(' '.join(sys.argv[1:])+'\\n')
if '-Dquarkus.container-image.builder=jib' in sys.argv:
    (p/'jib-image.digest').write_text('sha256:'+'a'*64)
if '-Dnative' in sys.argv:
    if os.environ.get('FAIL_NATIVE'):sys.exit(9)
    src=Path(os.environ['FAKE_NATIVE_SOURCE'])
    out=p/'high-perf-kube-java-1.0.0-SNAPSHOT-runner';out.write_bytes(src.read_bytes());out.chmod(0o755)
else:
    out=p/'quarkus-app';out.mkdir(exist_ok=True)
    (out/'quarkus-run.jar').write_text('TEST ONLY JVM artifact')
'''


class DemoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='runtime-demo-test-')
        self.root = Path(self.temp.name)
        (self.root / 'src/main').mkdir(parents=True)
        (self.root / 'src/main/app.txt').write_text('source A')
        (self.root / 'pom.xml').write_text('TEST ONLY')
        (self.root / 'mvnw').write_text(BUILD)
        (self.root / 'mvnw').chmod(0o755)
        self.bin = self.root / 'jdk/bin'
        self.bin.mkdir(parents=True)
        for name in ['java','native-image']:
            (self.bin / name).write_text(SERVER)
            (self.bin / name).chmod(0o755)
        self.native_source = self.root / 'test-server'
        self.native_source.write_text(SERVER)
        subprocess.run(['git','init','-q',str(self.root)],check=True)
        subprocess.run(['git','-C',str(self.root),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','test'],check=True)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));self.port=sock.getsockname()[1]
        self.env = patch.dict(os.environ, {'JAVA_HOME':str(self.bin.parent), 'GRAALVM_HOME':'', 'SDKMAN_CANDIDATES_DIR':str(self.root/'sdk/candidates'), 'FAKE_NATIVE_SOURCE':str(self.native_source), 'DEMO_PORT':str(self.port),'DEMO_CPUS':'2','DEMO_XMS':'64m','DEMO_XMX':'256m'})
        self.env.start()
        self.d = demo.Demo(self.root)

    def tearDown(self):
        try:
            self.d.down()
        finally:
            self.env.stop()
            self.temp.cleanup()

    def test_prepare_reuses_pair_and_keeps_jvm_when_native_builds(self):
        manifest = self.d.prepare()
        self.assertEqual(len((self.root/'build-calls').read_text().splitlines()),2)
        self.assertEqual(self.d.prepare(),manifest)
        self.assertEqual(len((self.root/'build-calls').read_text().splitlines()),2)
        folder=self.d.home/manifest['bundle']
        self.assertTrue((folder/'jvm/quarkus-app/quarkus-run.jar').exists())
        for runtime in ['jvm','native']:
            cost=demo.read_json(folder/'costs'/f'{runtime}.json')
            self.assertGreater(cost['build_seconds'],0)
            self.assertGreater(cost['artifact_bytes'],0)
            self.assertIsNone(cost['image_bytes'])
            self.assertTrue(cost['source']);self.assertTrue(cost['timestamp'])
        (self.root/'src/main/app.txt').write_text('source B')
        self.assertIsNone(self.d.bundle(required=False))
        newer=self.d.prepare()
        self.assertNotEqual(newer['bundle'],manifest['bundle'])
        self.assertTrue(folder.exists())

    def test_failed_native_build_preserves_published_pair(self):
        first=self.d.prepare()
        with patch.dict(os.environ,{'FAIL_NATIVE':'1'}):
            with self.assertRaisesRegex(demo.DemoError,'native build failed'):
                self.d.prepare(force=True)
        self.assertEqual(demo.read_json(self.d.current),first)
        self.assertEqual(self.d.bundle(),first)

    def test_up_switch_idempotence_settings_and_owned_shutdown(self):
        self.d.up()
        first=self.d.process()
        self.assertEqual(first['runtime'],'jvm')
        self.d.up()
        self.assertEqual(self.d.process()['pid'],first['pid'])
        with patch.dict(os.environ,{'DEMO_PORT':'8081','DEMO_XMX':'512m'}):
            self.d.switch()
        other=self.d.process()
        self.assertEqual(other['runtime'],'native')
        self.assertEqual(other['settings'],first['settings'])
        self.assertNotEqual(other['process_id'],first['process_id'])
        self.assertEqual(len((self.root/'build-calls').read_text().splitlines()),2)
        self.d.down();self.assertIsNone(self.d.process())
        self.assertTrue(self.d.current.exists())
        self.d.down()

    def test_occupied_port_is_not_killed_or_built_over(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',self.port));sock.listen()
            with self.assertRaisesRegex(demo.DemoError,'occupied'):
                self.d.up()
            self.assertFalse((self.root/'build-calls').exists())

    def test_foreign_pid_record_refuses_shutdown(self):
        demo.write_json(self.d.state,dict(pid=os.getpid(),token='a'*32))
        with self.assertRaisesRegex(demo.DemoError,'refusing to signal'):
            self.d.down()
        self.d.state.unlink()

    def test_invalid_sizes_and_stale_or_tampered_pair(self):
        with patch.dict(os.environ,{'DEMO_XMX':'256m; echo bad'}):
            with self.assertRaises(demo.DemoError):self.d.settings()
        manifest=self.d.prepare()
        executable=self.d.home/manifest['bundle']/'native/app'
        executable.write_text('tampered')
        with self.assertRaisesRegex(demo.DemoError,'artifact missing or changed'):
            self.d.bundle()

    def test_build_refuses_dev_mode_and_mismatched_toolchain(self):
        with patch.object(demo,'capture',return_value=str(self.d.root)+' io.quarkus.deployment.dev.DevModeMain'):
            with self.assertRaisesRegex(demo.DemoError,'dev mode'):
                self.d.no_dev_mode()
        with patch.object(demo,'capture',side_effect=['openjdk version "21.0.1"','native-image 25.0.1']):
            with self.assertRaisesRegex(demo.DemoError,'matching GraalVM JDK 25'):
                self.d.toolchain()

    def test_graalvm_home_can_differ_from_java_home(self):
        with patch.dict(os.environ,{'GRAALVM_HOME':str(self.bin.parent),'JAVA_HOME':str(self.root/'temurin')}):
            tools=self.d.toolchain()
        self.assertEqual(tools['java_home'],str(self.bin.parent))

    def test_sdkman_graalvm_is_found_when_path_and_java_home_do_not_expose_it(self):
        home=self.root/'sdk/candidates/java/25-graalce'
        (home/'bin').mkdir(parents=True)
        for name in ['java','native-image']:
            (home/'bin'/name).write_text(SERVER)
            (home/'bin'/name).chmod(0o755)
        with patch.dict(os.environ,{'JAVA_HOME':str(self.root/'temurin')}), patch.object(demo.shutil,'which',return_value=None):
            self.assertEqual(self.d.toolchain()['java_home'],str(home.resolve()))

    def test_invalid_explicit_graalvm_home_has_actionable_error(self):
        with patch.dict(os.environ,{'GRAALVM_HOME':str(self.root/'missing')}):
            with self.assertRaisesRegex(demo.DemoError,'No complete GraalVM installation'):
                self.d.toolchain()

    def test_failed_launch_removes_state_but_retains_diagnostic_log(self):
        self.d.prepare()
        with patch.dict(os.environ,{'FAIL_LAUNCH':'1'}):
            with self.assertRaisesRegex(demo.DemoError,'exited with code 7'):
                self.d.up()
        self.assertFalse(self.d.state.exists())
        output=io.StringIO()
        with contextlib.redirect_stdout(output):self.d.logs()
        self.assertIn('TEST ONLY launch failure',output.getvalue())

    def test_command_lock_rejects_overlap(self):
        with self.d.lock():
            with self.assertRaisesRegex(demo.DemoError,'Another demo command'):
                with self.d.lock():pass

    def test_launcher_attaches_process_matched_evidence_and_reset_removes_generated_files(self):
        self.d.up()
        state=self.d.process()
        evidence_path=Path(next(x.split('=',1)[1] for x in state['command'] if x.startswith('-Ddemo.evidence.path=')))
        evidence=demo.read_json(evidence_path)
        self.assertEqual(evidence['process_id'],state['process_id'])
        self.assertEqual(evidence['runtime'],'jvm')
        self.assertGreater(evidence['launch']['duration_ms'],0)
        self.assertGreater(evidence['costs']['artifact_bytes'],0)
        self.assertEqual(evidence['settings']['heap'],'-Xms64m -Xmx256m')
        self.d.reset()
        self.assertFalse(self.d.current.exists())
        self.assertFalse(self.d.state.exists())
        self.assertFalse((self.root/'target').exists())
        self.assertFalse(evidence_path.exists())
        self.assertTrue((self.root/'pom.xml').exists())
        generation=demo.read_json(self.d.home/'reset-generation.json')['id']
        self.d.up()
        state=self.d.process()
        evidence_path=Path(next(x.split('=',1)[1] for x in state['command'] if x.startswith('-Ddemo.evidence.path=')))
        self.assertEqual(demo.read_json(evidence_path)['reset_generation'],generation)

    def test_reset_refuses_unowned_pid_without_deleting_artifacts(self):
        demo.write_json(self.d.state,dict(pid=os.getpid(),token='a'*32))
        marker=self.d.home/'must-remain';marker.write_text('evidence')
        with self.assertRaisesRegex(demo.DemoError,'refusing to signal'):
            self.d.reset()
        self.assertTrue(marker.exists())
        self.d.state.unlink()

    def test_symlinked_artifact_root_is_refused(self):
        another=self.root/'another';another.mkdir()
        outside=self.root/'retained';outside.mkdir()
        marker=outside/'keep';marker.write_text('keep')
        (another/'demo-artifacts').symlink_to(outside,target_is_directory=True)
        with self.assertRaisesRegex(demo.DemoError,'symlinked'):
            demo.Demo(another)
        self.assertEqual(marker.read_text(),'keep')

    def test_jib_push_is_explicit_and_isolated_from_prepared_artifacts(self):
        (self.root/'target').mkdir();(self.root/'target/keep').write_text('host artifact')
        with patch.object(demo.shutil,'which',return_value=None):
            receipt=self.d.image('quay.io/example/demo:jvm-test','linux/amd64',True)
        self.assertEqual(receipt['builder'],'quarkus-container-image-jib')
        self.assertTrue(receipt['published']);self.assertIsNone(receipt['image_bytes'])
        self.assertIn('-Dquarkus.container-image.builder=jib',receipt['command'])
        self.assertIn('-Dquarkus.container-image.push=true',receipt['command'])
        self.assertFalse(any('docker-executable-name' in x for x in receipt['command']))
        self.assertEqual((self.root/'target/keep').read_text(),'host artifact')
        self.assertEqual(demo.read_json(self.d.home/'images/latest.json')['digest'],'sha256:'+'a'*64)

    def test_image_rejects_registry_web_urls_and_prepare_requires_explicit_push_image(self):
        with self.assertRaisesRegex(demo.DemoError,'tagged image'):
            self.d.image('https://quay.io/repository/example/demo','linux/amd64')
        with patch.object(demo.sys,'argv',['demo.sh','prepare','--push-image']),patch.object(demo,'Demo',return_value=self.d),patch.object(self.d,'prepare') as prepare:
            self.assertEqual(demo.main(),1);prepare.assert_not_called()

    def run_scale_fixture(self, original, target, failure=False):
        calls=[];poll=[0]
        template={'spec':{'containers':[{'name':'app','image':'quay.io/example/demo:jvm','resources':{'requests':{'cpu':'100m'}}}]}}
        def result(args,**kwargs):
            calls.append(args)
            if 'config' in args:return subprocess.CompletedProcess(args,0,'test-context','')
            if 'scale' in args:return subprocess.CompletedProcess(args,0,'scaled','')
            kind=args[args.index('get')+1]
            if kind=='deployment':
                poll[0]+=1;first=poll[0]==1;ready=original if poll[0]<3 else target
                value={'metadata':{'uid':'dep','generation':2},'spec':{'replicas':original if first else target,'selector':{'matchLabels':{'app':'demo'}},'template':template},'status':{'readyReplicas':ready,'availableReplicas':ready,'updatedReplicas':ready,'replicas':ready,'observedGeneration':2}}
            elif kind=='replicasets':value={'items':[{'metadata':{'uid':'rs','ownerReferences':[{'uid':'dep'}]}}]}
            else:
                if failure:return subprocess.CompletedProcess(args,1,'','TEST permission denied')
                count=target if poll[0]>=3 else original
                value={'items':[{'metadata':{'ownerReferences':[{'uid':'rs'}]},'status':{'phase':'Running','conditions':[{'type':'Ready','status':'True'}]}} for _ in range(count)]}
            return subprocess.CompletedProcess(args,0,json.dumps(value),'')
        with patch.object(demo.shutil,'which',return_value='oc'),patch.object(demo.subprocess,'run',side_effect=result),patch.object(demo.time,'sleep'):
            result=self.d.scale('demo','app',target,30)
        return result,calls

    def test_scale_out_and_in_require_observed_convergence(self):
        for original,target in [(1,100),(100,1)]:
            record,calls=self.run_scale_fixture(original,target)
            self.assertEqual(record['status'],'complete');self.assertGreaterEqual(record['duration_ms'],0)
            self.assertEqual(len(record['timeline']),2)
            self.assertEqual(record['timeline'][-1]['ready'],target)
            self.assertTrue(any('--replicas='+str(target) in x for x in calls))
            self.assertNotIn('token',json.dumps(record))

    def test_scale_failures_are_recorded_without_a_success_duration(self):
        with self.assertRaisesRegex(demo.DemoError,'permission denied'):
            self.run_scale_fixture(1,100,True)
        record=demo.read_json(self.d.home/'scales/latest.json')
        self.assertEqual(record['status'],'failed');self.assertIsNone(record['duration_ms'])

    def test_peak_memory_platform_units_and_unknown(self):
        self.assertEqual(demo.peak_mib('1048576  maximum resident set size','Darwin'),1)
        self.assertEqual(demo.peak_mib('Maximum resident set size (kbytes): 2048','Linux'),2)
        self.assertIsNone(demo.peak_mib('no measurement','Linux'))


if __name__ == '__main__':
    unittest.main()
