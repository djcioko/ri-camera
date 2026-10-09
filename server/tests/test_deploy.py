import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "deploy" / "nginx_config.py"
spec = importlib.util.spec_from_file_location("nginx_config", MODULE_PATH)
nginx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nginx)


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


if __name__ == "__main__":
    unittest.main()
