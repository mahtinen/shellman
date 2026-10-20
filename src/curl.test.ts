import { describe, expect, it } from 'vitest';
import type { HttpRequest } from './api';
import { curlCommand, parseCurl, splitCommand } from './curl';

const post: HttpRequest = {
  method: 'POST',
  url: 'https://api.example.com/users',
  headers: [
    { name: 'Authorization', value: 'Bearer {{API_TOKEN}}' },
    { name: 'Content-Type', value: 'application/json' },
  ],
  body: { type: 'raw', text: `{"name": "O'Brien"}` },
  followRedirects: true,
  secrets: [{ name: 'API_TOKEN', value: 'op://Example Vault/Example API/credential' }],
};

describe('copy as curl', () => {
  it('bash', () => {
    expect(curlCommand(post, 'bash')).toBe(
      [
        'curl \\',
        '  --variable %API_TOKEN \\',
        '  --url https://api.example.com/users \\',
        "  --expand-header 'Authorization: Bearer {{API_TOKEN}}' \\",
        "  --header 'Content-Type: application/json' \\",
        `  --data-raw '{"name": "O'\\''Brien"}' \\`,
        '  -L',
      ].join('\n'),
    );
  });

  it('PowerShell 7 and cmd', () => {
    const ps = curlCommand({ ...post, method: 'PUT', secrets: [], headers: [] }, 'powershell');
    expect(ps).toBe(['curl.exe -X PUT `', '  --url https://api.example.com/users `', `  --data-raw '{"name": "O''Brien"}' \``, '  -L'].join('\n'));
    const cmd = curlCommand({ method: 'GET', url: 'https://api.example.com/a b', headers: [{ name: 'X', value: 'say "hi"' }] }, 'cmd');
    expect(cmd).toBe(['curl.exe ^', '  --url "https://api.example.com/a b" ^', '  --header "X: say ""hi"""'].join('\n'));
    // PowerShell ends a '…' string at a typographic quote too.
    expect(curlCommand({ method: 'GET', url: 'https://example.com', headers: [{ name: 'X', value: 'it’s' }] }, 'powershell')).toContain(`--header 'X: it’’s'`);
    expect(() => curlCommand({ ...post, secrets: [], body: { type: 'raw', text: 'a\nb' } }, 'cmd')).toThrow(/line breaks/);
  });

  it('sets 1Password references and runs curl through op', () => {
    const refs = { API_TOKEN: 'op://Example Vault/Example API/credential' };
    expect(curlCommand(post, 'powershell', refs)).toMatch(/^\$env:API_TOKEN = 'op:\/\/Example Vault\/Example API\/credential'; op\.exe run -- curl\.exe `/);
    expect(curlCommand(post, 'bash', refs)).toMatch(/^API_TOKEN='op:\/\/Example Vault\/Example API\/credential' op run -- curl \\/);
    expect(curlCommand(post, 'cmd', refs)).toMatch(/^set "API_TOKEN=op:\/\/Example Vault\/Example API\/credential" && op\.exe run -- curl\.exe \^/);
    expect(curlCommand(post, 'powershell', refs, 'example.1password.com')).toContain('; op.exe run --account example.1password.com -- curl.exe');
  });

  it('names methods curl would not pick itself', () => {
    expect(curlCommand({ method: 'HEAD', url: 'https://example.com' }, 'bash')).toBe('curl -I \\\n  --url https://example.com');
    expect(curlCommand({ method: 'GET', url: 'https://example.com' }, 'bash')).toBe('curl \\\n  --url https://example.com');
    expect(curlCommand({ method: 'DELETE', url: 'https://example.com' }, 'bash')).toMatch(/^curl -X DELETE/);
    // A form without fields writes no data option, so POST is named.
    expect(curlCommand({ method: 'POST', url: 'https://example.com', body: { type: 'form', fields: [] } }, 'bash')).toMatch(/^curl -X POST/);
  });
});

describe('paste curl command', () => {
  it('splits like a shell', () => {
    expect(splitCommand(`curl 'a b' "c \\"d\\"" e\\ f $'g\\nh'`)).toEqual(['curl', 'a b', 'c "d"', 'e f', 'g\nh']);
    expect(splitCommand('curl ^"https://example.com/^&x^" ^\n  -H ^"A: b^"')).toEqual(['curl', 'https://example.com/&x', '-H', 'A: b']);
    expect(splitCommand('curl -d "" x')).toEqual(['curl', '-d', '', 'x']);
    // A browser's cmd version writes a line break in a value as ^ and two line breaks.
    expect(splitCommand('curl ^"https://example.com^" ^\n  --data-raw ^"a^\n\nb^"')).toEqual(['curl', 'https://example.com', '--data-raw', 'a\nb']);
  });

  it('reads a browser "Copy as cURL"', () => {
    const { doc, skipped } = parseCurl(`curl 'https://api.example.com/users?limit=20' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer {{API_TOKEN}}' \\
  -H 'content-type: application/json' \\
  --data-raw '{"name":"Test User"}' \\
  --compressed`);
    expect(skipped).toEqual([]);
    expect(doc.method).toBe('POST');
    expect(doc.url).toBe('https://api.example.com/users?limit=20');
    expect(doc.headers.map((h) => h.name)).toEqual(['accept', 'authorization', 'content-type']);
    expect(doc.body).toMatchObject({ type: 'json', text: '{"name":"Test User"}' });
  });

  it('options', () => {
    const r = parseCurl('curl.exe -sSLk -XPUT -u me:pa:ss -m 2.5 --url https://example.com -d a=1 -d b=2 --proxy http://proxy.example.com:8080');
    expect(r.doc.method).toBe('PUT');
    expect(r.doc.auth).toEqual({ type: 'basic', username: 'me', password: 'pa:ss' });
    expect(r.doc.options).toEqual({ followRedirects: true, insecure: true, timeoutSeconds: 3 });
    expect(r.doc.body).toMatchObject({ type: 'text', text: 'a=1&b=2' });
    expect(r.doc.headers).toEqual([{ name: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true }]);
    expect(r.skipped).toEqual(['--proxy']);

    const get = parseCurl('curl -G https://example.com/search -d q=x');
    expect([get.doc.method, get.doc.url, get.doc.body.type]).toEqual(['GET', 'https://example.com/search?q=x', 'none']);
    const json = parseCurl(`curl --json '{"a":1}' https://example.com`);
    expect([json.doc.method, json.doc.body.type]).toEqual(['POST', 'json']);
    expect(json.doc.headers).toEqual([{ name: 'Accept', value: 'application/json', enabled: true }]);
    const form = parseCurl('curl -F note=hi -F "upload=@C:\\Users\\me\\a.png;type=image/png" https://example.com');
    expect(form.doc.body.fields).toEqual([
      { name: 'note', value: 'hi', enabled: true },
      { name: 'upload', value: 'C:\\Users\\me\\a.png', enabled: true, file: true },
    ]);
    expect(parseCurl('curl -I https://example.com').doc.method).toBe('HEAD');
  });

  it('refuses what is not a curl command', () => {
    expect(() => parseCurl('wget https://example.com')).toThrow(/not a curl/);
    expect(() => parseCurl('curl -s')).toThrow(/no URL/);
  });
});
