import importlib.util
import inspect
import itertools
import json
from pathlib import Path
import resource
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "deploy" / "nginx_config.py"
spec = importlib.util.spec_from_file_location("nginx_config", MODULE_PATH)
nginx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nginx)

with patch.dict(sys.modules, {"nginx_config": nginx}):
    spec = importlib.util.spec_from_file_location("preflight", MODULE_PATH.with_name("preflight.py"))
    preflight = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(preflight)
    with patch.dict(sys.modules, {"preflight": preflight}):
        spec = importlib.util.spec_from_file_location("ri_install", MODULE_PATH.with_name("install.py"))
        installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(installer)


class NginxPatchTests(unittest.TestCase):
    def test_only_exact_tls_vhost_changes_and_repeated_patch_is_identical(self):
        before = '''# Existing services must be byte-for-byte preserved.
server { listen 80; server_name djcioko.ro; return 301 https://$host$request_uri; }
server { listen 443 ssl; server_name other.djcioko.ro; location / { proxy_pass http://127.0.0.1:8095; } }
server {
    listen 443 ssl;
    server_name djcioko.ro www.djcioko.ro;
    # a misleading closing brace: }
    location / { add_header Example "brace } and # hash"; }
}
'''
        after = nginx.patch_vhost(before, "djcioko.ro")
        insertion = "    include /etc/nginx/snippets/ri-subtitles.conf;\n"
        self.assertEqual(after.replace(insertion, "", 1), before)
        self.assertEqual(after.count(insertion), 1)
        self.assertEqual(nginx.patch_vhost(after, "djcioko.ro"), after)

    def test_ambiguous_tls_blocks_and_unknown_match_fail_closed(self):
        block = "server { listen 443 ssl; server_name djcioko.ro; }\n"
        with self.assertRaises(nginx.ConfigurationError):
            nginx.patch_vhost(block + block, "djcioko.ro")
        for names in ("*.djcioko.ro", "~^djcioko.ro$", "www.djcioko.ro"):
            with self.assertRaises(nginx.ConfigurationError):
                nginx.patch_vhost(block.replace("server_name djcioko.ro", "server_name " + names), "djcioko.ro")

    def test_existing_route_conflict_and_duplicate_include_are_rejected(self):
        template = "server { listen [::]:443 ssl; server_name djcioko.ro; %s }"
        for directive in (
            "location /api/ri-subtitles/ { return 404; }",
            "location ~ ^/api/ri-subtitles { deny all; }",
            "include /etc/nginx/snippets/ri-subtitles.conf; include /etc/nginx/snippets/ri-subtitles.conf;",
        ):
            with self.assertRaises(nginx.ConfigurationError):
                nginx.patch_vhost(template % directive, "djcioko.ro")

    def test_dump_selection_uses_active_files_not_commented_domains(self):
        dump = '''# configuration file /etc/nginx/nginx.conf:
user www-data;
events { worker_connections 1024; }
http { include /etc/nginx/sites-enabled/*; }
# configuration file /etc/nginx/sites-enabled/other:
server { listen 443 ssl; server_name another.ro; } # server_name djcioko.ro;
# configuration file /etc/nginx/sites-enabled/site:
server { listen 80; server_name djcioko.ro; }
server { listen 443 ssl; server_name djcioko.ro; }
'''
        chosen = nginx.inspect_dump(dump, "djcioko.ro")
        self.assertEqual(chosen["vhost"], "/etc/nginx/sites-enabled/site")
        self.assertEqual(chosen["nginx_user"], "www-data")
        self.assertEqual(chosen["nginx_group"], "www-data")

    def test_invalid_or_truncated_config_and_no_explicit_worker_user_fail(self):
        for text in ("server { listen 443 ssl; server_name djcioko.ro;", 'server { set $x "unfinished; }'):
            with self.assertRaises(nginx.ConfigurationError):
                nginx.patch_vhost(text, "djcioko.ro")
        with self.assertRaises(nginx.ConfigurationError):
            nginx.inspect_dump("# configuration file /etc/nginx/site:\nserver { listen 443 ssl; server_name djcioko.ro; }", "djcioko.ro")

    def test_quoted_empty_or_delimiters_are_values_and_managed_snippet_parses(self):
        original = '''server { listen 443 ssl; server_name djcioko.ro;
    proxy_set_header Connection "";
    proxy_set_header Host ${host};
    set $open "{";
    set $close '}';
    set $semi ";";
}'''
        self.assertIn("include /etc/nginx/snippets/ri-subtitles.conf;", nginx.patch_vhost(original, "djcioko.ro"))
        snippet = MODULE_PATH.with_name("ri-subtitles.nginx.conf").read_text()
        self.assertEqual(nginx.parse(snippet)[0]["args"], ["location", "^~", "/api/ri-subtitles/"])

    def test_ovh_host_selects_only_its_exact_active_tls_vhost(self):
        other = "server { listen 443 ssl; server_name manager.djshopitalia.it; location / { proxy_pass http://127.0.0.1:8030; } }\n"
        target = "server { listen 443 ssl; server_name ai.djshopitalia.it; location / { proxy_pass http://127.0.0.1:8040; } }\n"
        dump = "# configuration file /etc/nginx/nginx.conf:\nuser www-data;\n"
        dump += "# configuration file /etc/nginx/sites-enabled/manager:\n" + other
        dump += "# configuration file /etc/nginx/sites-enabled/ai:\n" + target
        self.assertEqual(nginx.inspect_dump(dump, "ai.djshopitalia.it")["vhost"], "/etc/nginx/sites-enabled/ai")
        changed = nginx.patch_vhost(other + target, "ai.djshopitalia.it")
        self.assertTrue(changed.startswith(other))
        self.assertEqual(changed.replace("\n    include " + nginx.INCLUDE + ";\n", "", 1), other + target)
        for names in ("*.djshopitalia.it", "~^ai.djshopitalia.it$", "notai.djshopitalia.it"):
            with self.assertRaises(nginx.ConfigurationError):
                nginx.patch_vhost(target.replace("ai.djshopitalia.it", names), "ai.djshopitalia.it")
        with self.assertRaises(nginx.ConfigurationError):
            nginx.inspect_dump(dump + "# configuration file /etc/nginx/sites-enabled/duplicate:\n" + target, "ai.djshopitalia.it")

    def test_requested_host_rejects_url_wildcards_and_configuration_characters(self):
        for host in ("*.djshopitalia.it", "https://ai.djshopitalia.it", "ai.djshopitalia.it:443", "ai.djshopitalia.it/path", "ai.djshopitalia.it;", "$host", "127.0.0.1", "localhost", "-ai.djshopitalia.it", "ai..djshopitalia.it"):
            with self.subTest(host=host), self.assertRaises(nginx.ConfigurationError):
                nginx.patch_vhost(f"server {{ listen 443 ssl; server_name {host}; }}", host)


class DeploymentHostTests(unittest.TestCase):
    def curl_responses(self, replies):
        calls = []
        pending = list(replies)
        def respond(argv, **kwargs):
            calls.append(argv)
            status, mime, body, code = pending.pop(0) if len(pending) > 1 else pending[0]
            Path(argv[argv.index("--output") + 1]).write_bytes(body)
            return SimpleNamespace(returncode=code, stdout=f"{status:03d}\n{mime}\n", stderr="PRIVATE_RESPONSE_DETAILS")
        return calls, respond

    def test_changed_or_legacy_marker_host_stops_before_installation_mutations(self):
        self.assertIn("host", inspect.signature(installer.install).parameters)
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "installation.json"
            for existing in ({"host": "another.example"}, {"revision": "legacy"}):
                marker.write_text(json.dumps(existing))
                before = marker.read_bytes()
                with patch.object(installer, "MARKER", marker), patch.object(installer, "inspect"), patch.object(installer, "create_release") as release, patch.object(installer, "atomic_write") as write, patch.object(installer.subprocess, "run") as run:
                    with self.assertRaisesRegex(preflight.PreflightError, "host|domeniu"):
                        installer.install(Path(directory), host="ai.djshopitalia.it")
                    release.assert_not_called()
                    write.assert_not_called()
                    run.assert_not_called()
                self.assertEqual(marker.read_bytes(), before)
                self.assertEqual(list(Path(directory).iterdir()), [marker])

    def test_https_verification_checks_local_vhost_then_public_endpoint(self):
        calls, respond = self.curl_responses([(200, "application/json", b'{"ready": true}', 0)])
        with patch.object(installer.subprocess, "run", side_effect=respond):
            installer.verify_https("ai.djshopitalia.it")
        self.assertEqual(len(calls), 2)
        self.assertIn("ai.djshopitalia.it:443:127.0.0.1", calls[0])
        self.assertIn("--resolve", calls[0])
        self.assertNotIn("--resolve", calls[1])
        for call in calls:
            self.assertEqual(call[:2], ["curl", "--disable"])
            self.assertEqual(call[-1], "https://ai.djshopitalia.it/api/ri-subtitles/v1/health")
            self.assertNotIn("--insecure", call)
            self.assertNotIn("--location", call)
            self.assertNotIn("--fail", call)
            self.assertIn("--max-filesize", call)

    def test_probe_file_cap_is_enforced_in_child_without_changing_parent(self):
        self.assertTrue(hasattr(installer, "limit_probe_files"))
        before = resource.getrlimit(resource.RLIMIT_FSIZE)
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "too-large"
            result = subprocess.run([sys.executable, "-B", "-c", "import sys; open(sys.argv[1], 'wb').write(b'x' * 131074)", str(target)],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=installer.limit_probe_files)
            self.assertNotEqual(result.returncode, 0)
            self.assertLessEqual(target.stat().st_size, installer.PROBE_MAX_BYTES + 1)
        self.assertEqual(resource.getrlimit(resource.RLIMIT_FSIZE), before)

    def test_https_retries_html_and_redirect_until_strict_json_readiness(self):
        calls, respond = self.curl_responses([
            (200, "text/html", b"<html>old application</html>", 0),
            (301, "text/html", b"redirect", 0),
            (200, "application/json; charset=utf-8", b'{"ready": true}', 0),
        ])
        with patch.object(installer.subprocess, "run", side_effect=respond), patch.object(installer.time, "sleep"), patch.object(installer.time, "monotonic", side_effect=itertools.count().__next__):
            installer.verify_https("ai.djshopitalia.it")
        self.assertEqual(len(calls), 4)

    def test_permanent_bad_https_response_reports_metadata_without_response_content(self):
        for status, mime, body in ((200, "text/html", b"PRIVATE_BODY"), (301, "text/html", b""), (200, "application/json", b"[]"), (200, "application/json", b'"PRIVATE_BODY"'), (200, "application/json", b'{"ready": 1}'), (200, "application/json", b'{"ready": false}')):
            calls, respond = self.curl_responses([(status, mime, body, 0)])
            with self.subTest(body=body), patch.object(installer.subprocess, "run", side_effect=respond), patch.object(installer.time, "sleep"), patch.object(installer.time, "monotonic", side_effect=itertools.count().__next__):
                with self.assertRaises(preflight.PreflightError) as caught:
                    installer.verify_https("ai.djshopitalia.it")
            message = str(caught.exception)
            for expected in ("HTTPS local", f"HTTP={status}", f"type={mime}", f"bytes={len(body)}", "curl=0"):
                self.assertIn(expected, message)
            self.assertNotIn("PRIVATE_BODY", message)
            self.assertNotIn("PRIVATE_RESPONSE_DETAILS", message)
            self.assertGreater(len(calls), 1)

    def test_tls_failure_reports_exit_code_without_retries_or_stderr(self):
        calls, respond = self.curl_responses([(0, "", b"", 60)])
        with patch.object(installer.subprocess, "run", side_effect=respond):
            with self.assertRaises(preflight.PreflightError) as caught:
                installer.verify_https("ai.djshopitalia.it")
        self.assertEqual(len(calls), 1)
        self.assertIn("curl=60", str(caught.exception))
        self.assertNotIn("PRIVATE_RESPONSE_DETAILS", str(caught.exception))

    def test_invalid_uds_auth_json_reports_safe_phase_status_type_and_size(self):
        response = SimpleNamespace(status=401, getheader=lambda name, default=None: "application/json", read=lambda count: b"PRIVATE_BODY")
        with patch.object(installer.http.client, "HTTPConnection") as connection, patch.object(installer.socket, "socket"):
            connection.return_value.getresponse.return_value = response
            with self.assertRaises(preflight.PreflightError) as caught:
                installer.uds_request("GET", "/v1/jobs/" + "0" * 32, "PRIVATE_ACCESS_CODE", phase="UDS auth", expected_status=401)
        message = str(caught.exception)
        for expected in ("UDS auth", "HTTP=401", "type=application/json", "bytes=12"):
            self.assertIn(expected, message)
        self.assertNotIn("PRIVATE_BODY", message)
        self.assertNotIn("PRIVATE_ACCESS_CODE", message)

    def test_uds_health_timeout_keeps_last_safe_failure_context(self):
        error = preflight.PreflightError("UDS health: HTTP=200 type=text/html bytes=7")
        with patch.object(installer, "uds_request", side_effect=error), patch.object(installer.time, "sleep"), patch.object(installer.time, "monotonic", side_effect=itertools.count().__next__):
            with self.assertRaises(preflight.PreflightError) as caught:
                installer.wait_ready()
        self.assertIn("HTTP=200 type=text/html bytes=7", str(caught.exception))

    def test_ffmpeg_n_prefix_is_accepted_without_accepting_old_versions(self):
        self.assertTrue(hasattr(preflight, "validate_ffmpeg_version"))
        for value in ("ffmpeg version 6.1.1 Copyright", "ffmpeg version n8.0.1 Copyright"):
            preflight.validate_ffmpeg_version(value)
        for value in ("ffmpeg version n5.1.6 Copyright", "ffmpeg version unknown"):
            with self.assertRaises(preflight.PreflightError):
                preflight.validate_ffmpeg_version(value)


if __name__ == "__main__":
    unittest.main()
