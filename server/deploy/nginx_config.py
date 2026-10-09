"""Conservative, lossless insertion into one active, explicit TLS vhost.

No nginx configuration is rewritten or evaluated. Unknown/ambiguous layouts
are left for the administrator; nginx -t is still mandatory before reload.
"""
import re


INCLUDE = "/etc/nginx/snippets/ri-subtitles.conf"
DEFAULT_HOST = "djcioko.ro"


class ConfigurationError(ValueError):
    pass


def validate_host(host):
    label = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    if (not isinstance(host, str) or len(host) > 253
            or not re.fullmatch(label + r"(?:\." + label + r")+", host)
            or host.rsplit(".", 1)[-1].isdigit()):
        raise ConfigurationError("Host invalid: folosiți un domeniu DNS explicit, cu litere mici, fără URL, port sau wildcard.")
    return host


def tokens(text):
    result = []
    i = 0
    while i < len(text):
        if text[i].isspace():
            i += 1
            continue
        if text[i] == "#":
            end = text.find("\n", i)
            i = len(text) if end < 0 else end
            continue
        start = i
        if text[i] in "{};":
            result.append((text[i], i, i + 1, True))
            i += 1
            continue
        value = ""
        quote = None
        while i < len(text):
            char = text[i]
            if char == "\\":
                if i + 1 == len(text):
                    raise ConfigurationError("Nginx: escape neterminat.")
                value += text[i + 1]
                i += 2
                continue
            if quote:
                if char == quote:
                    quote = None
                else:
                    value += char
                i += 1
                continue
            if char in "\"'":
                quote = char
                i += 1
                continue
            if text[i:i + 2] == "${":
                end = text.find("}", i + 2)
                if end < 0:
                    raise ConfigurationError("Nginx: variabilă neterminată.")
                value += text[i:end + 1]
                i = end + 1
                continue
            if char.isspace() or char in "{};#":
                break
            value += char
            i += 1
        if quote:
            raise ConfigurationError("Nginx: text între ghilimele neterminat.")
        result.append((value, start, i, False))
    return result


def parse(text):
    items = tokens(text)
    position = 0

    def body(nested=False):
        nonlocal position
        nodes = []
        while position < len(items):
            if items[position][3] and items[position][0] == "}":
                if not nested:
                    raise ConfigurationError("Nginx: acoladă fără pereche.")
                close = items[position][1]
                position += 1
                return nodes, close
            args = []
            start = items[position][1]
            while position < len(items) and not items[position][3]:
                args.append(items[position][0])
                position += 1
            if not args or position == len(items) or items[position][0] == "}":
                raise ConfigurationError("Nginx: directivă incompletă.")
            separator, _, end, _ = items[position]
            position += 1
            if separator == "{":
                children, close = body(True)
                nodes.append({"args": args, "children": children, "start": start, "close": close})
            else:
                nodes.append({"args": args, "children": None, "start": start, "close": end})
        if nested:
            raise ConfigurationError("Nginx: bloc neterminat.")
        return nodes, len(text)

    return body()[0]


def walk(nodes):
    for node in nodes:
        yield node
        if node["children"] is not None:
            yield from walk(node["children"])


def matching_servers(text, domain):
    domain = validate_host(domain)
    matches = []
    for node in walk(parse(text)):
        if node["args"] != ["server"] or node["children"] is None:
            continue
        directives = [child["args"] for child in node["children"] if child["children"] is None]
        names = [name for args in directives if args[0] == "server_name" for name in args[1:]]
        # Require explicit TLS. A bare port 443 does not establish ssl.
        tls = any(args[0] == "listen" and "ssl" in args[1:] for args in directives)
        if domain in names and tls:
            matches.append(node)
    return matches


def patch_vhost(text, domain):
    matches = matching_servers(text, domain)
    if len(matches) != 1:
        raise ConfigurationError(f"Este necesar exact un vhost TLS cu server_name {domain} explicit.")
    server = matches[0]
    inclusions = 0
    for child in walk(server["children"]):
        args = child["args"]
        if args[0] == "include" and INCLUDE in args[1:]:
            if child not in server["children"]:
                raise ConfigurationError("Include-ul existent nu este direct în vhost.")
            inclusions += 1
        if args[0] == "location" and any("ri-subtitles" in arg for arg in args[1:]):
            raise ConfigurationError("Ruta ri-subtitles există deja în vhost; verificare manuală necesară.")
    if inclusions > 1:
        raise ConfigurationError("Include ri-subtitles duplicat.")
    if inclusions:
        return text
    close = server["close"]
    line = text.rfind("\n", 0, close) + 1
    # Insert before closing indentation, preserving all original bytes.
    if text[line:close].strip():
        insertion = "\n    include " + INCLUDE + ";\n"
        return text[:close] + insertion + text[close:]
    indent = text[line:close] + "    "
    return text[:line] + indent + "include " + INCLUDE + ";\n" + text[line:]


def split_dump(dump):
    headers = list(re.finditer(r"^# configuration file (/[^\r\n]+):\s*$", dump, re.M))
    if not headers:
        raise ConfigurationError("nginx -T nu a enumerat fișierele active.")
    result = {}
    for index, header in enumerate(headers):
        path = header.group(1)
        if path in result:
            raise ConfigurationError("Același fișier apare de două ori în nginx -T.")
        end = headers[index + 1].start() if index + 1 < len(headers) else len(dump)
        result[path] = dump[header.end():end].lstrip("\r\n")
    return result


def inspect_dump(dump, domain=DEFAULT_HOST):
    domain = validate_host(domain)
    files = split_dump(dump)
    matches = []
    users = []
    for path, text in files.items():
        matches.extend((path, node) for node in matching_servers(text, domain))
        for node in parse(text):
            if node["children"] is None and node["args"][0] == "user":
                users.append(node["args"][1:])
    if len(matches) != 1:
        raise ConfigurationError(f"Vhost TLS activ absent sau ambiguu pentru {domain}.")
    if len(users) != 1 or not 1 <= len(users[0]) <= 2:
        raise ConfigurationError("Utilizatorul Nginx trebuie să fie explicit și unic în nginx -T.")
    user = users[0][0]
    group = users[0][1] if len(users[0]) == 2 else user
    if not all(re.fullmatch(r"[a-z_][a-z0-9_-]*", item) for item in (user, group)) or user == "root" or group == "root":
        raise ConfigurationError("Utilizatorul/grupul Nginx nu poate fi folosit în siguranță pentru socket.")
    return {"vhost": matches[0][0], "nginx_user": user, "nginx_group": group}
