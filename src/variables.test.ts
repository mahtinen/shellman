import { describe, expect, it } from 'vitest';
import { newRequest, type RequestDoc } from './requestFile';
import { localEnvFile } from './dotenv';
import { checkRows, choiceLabel, collectVariables, currentChoice, describeVariable, displayValue, editRow, filesOutside, findSecretLiterals, opRef, overriddenRows, prepareRequest, rowPicks, rowScope, scopeFile, SCOPES, segments, splitVariables, variableRows, variableWrites, varRow } from './variables';

const files = (env = 'staging') => ({
  env,
  environment: { baseUrl: 'https://staging.example.com', tenant: 'acme-test' },
  dotenv: [
    { path: '.env', text: 'baseUrl=https://default.example.com\nAPI_TOKEN=op://Example Vault/Example API/credential\nPAGE=20\n' },
    { path: '.env.local', text: 'userId=42\nPASSWORD=hunter2\n' },
    { path: '.env.staging.local', text: 'userId=43\n' },
    { path: '.env.prod.local', text: 'userId=1\n' },
  ],
});

const opts = { folder: 'C:\\Projects\\api', followRedirects: true, timeoutSeconds: 30 };

describe('variables', () => {
  it('looks them up in order', () => {
    const vars = collectVariables(files());
    expect(vars.get('baseUrl')).toMatchObject({ value: 'https://staging.example.com', source: 'environments/staging.json', secret: false });
    expect(vars.get('PAGE')).toMatchObject({ value: '20', source: '.env', secret: false });
    expect(vars.get('API_TOKEN')).toMatchObject({ source: '.env', secret: true });
    expect(vars.get('userId')).toMatchObject({ value: '43', source: '.env.staging.local', secret: true });
    expect(collectVariables(files('')).get('userId')?.value).toBe('42');
  });

  it('shows secrets hidden and references as they are', () => {
    const vars = collectVariables(files());
    expect(displayValue(vars.get('PASSWORD')!, true)).toBe('••••••••');
    expect(displayValue(vars.get('PASSWORD')!, false)).toBe('hunter2');
    expect(displayValue(vars.get('API_TOKEN')!, true)).toBe('op://Example Vault/Example API/credential');
    expect(displayValue(vars.get('userId')!, true)).toBe('••••••••');
    expect(segments('{{baseUrl}}/users/{{userId}}?k={{nope}}', vars, true)).toEqual([
      { text: 'https://staging.example.com', kind: 'var', name: 'baseUrl' },
      { text: '/users/', kind: 'text' },
      { text: '••••••••', kind: 'secret', name: 'userId' },
      { text: '?k=', kind: 'text' },
      { text: '{{nope}}', kind: 'missing', name: 'nope' },
    ]);
  });

  it('splits text into plain parts and variables as written', () => {
    expect(splitVariables('{"id": {{ userId }}, "x": "{{a.b-c}}"}')).toEqual([
      { text: '{"id": ' },
      { text: '{{ userId }}', name: 'userId' },
      { text: ', "x": "' },
      { text: '{{a.b-c}}', name: 'a.b-c' },
      { text: '"}' },
    ]);
    // Not a valid name: plain text.
    expect(splitVariables('{{1x}} {{}}')).toEqual([{ text: '{{1x}} {{}}' }]);
    expect(splitVariables('')).toEqual([]);
  });

  it('describes a variable for hovering it', () => {
    const vars = collectVariables(files());
    expect(describeVariable('baseUrl', vars, true)).toEqual({ kind: 'var', title: '{{baseUrl}} = https://staging.example.com\nfrom environments/staging.json. Ctrl+click to edit.' });
    // Secret values stay hidden; a 1Password reference is only an address.
    expect(describeVariable('PASSWORD', vars, true).title).not.toContain('hunter2');
    expect(describeVariable('PASSWORD', vars, true).kind).toBe('secret');
    expect(describeVariable('API_TOKEN', vars, true).title).toContain('op://Example Vault/Example API/credential (1Password, filled in when sending)');
    expect(describeVariable('nope', vars, true)).toEqual({ kind: 'missing', title: "{{nope}} isn't defined. Ctrl+click to add it." });
  });

  it('fills in plain values and leaves secrets to curl', () => {
    const doc: RequestDoc = {
      ...newRequest(),
      method: 'POST',
      url: '{{baseUrl}}/users?limit={{PAGE}}',
      headers: [
        { name: 'X-Tenant', value: '{{tenant}}', enabled: true },
        { name: 'X-Off', value: '{{undefinedButDisabled}}', enabled: false },
      ],
      auth: { type: 'bearer', token: '{{API_TOKEN}}' },
      body: { type: 'json', text: '{"user": {{userId}}}', fields: [], path: '' },
    };
    const { request, missing } = prepareRequest(doc, collectVariables(files()), opts);
    expect(missing).toEqual([]);
    expect(request.url).toBe('https://staging.example.com/users?limit=20');
    expect(request.headers).toEqual([
      { name: 'X-Tenant', value: 'acme-test' },
      { name: 'Authorization', value: 'Bearer {{API_TOKEN}}' },
      { name: 'Content-Type', value: 'application/json' },
    ]);
    expect(request.body).toEqual({ type: 'raw', text: '{"user": {{userId}}}' });
    expect(request.secrets).toEqual([
      { name: 'API_TOKEN', value: 'op://Example Vault/Example API/credential' },
      { name: 'userId', value: '43' },
    ]);
    expect(JSON.stringify(request)).not.toContain('hunter2');
  });

  it('reports variables that are defined nowhere', () => {
    const doc = { ...newRequest(), url: '{{host}}/x', headers: [{ name: 'X', value: '{{a}}{{host}}', enabled: true }] };
    expect(prepareRequest(doc, new Map(), opts).missing).toEqual(['host', 'a']);
  });

  it('auth, files and options', () => {
    const vars = collectVariables(files());
    const basic = prepareRequest({ ...newRequest(), url: 'https://example.com', auth: { type: 'basic', username: 'me', password: '{{PASSWORD}}' } }, vars, opts).request;
    expect(basic.user).toBe('me:{{PASSWORD}}');
    const key = prepareRequest({ ...newRequest(), url: 'https://example.com/?a=1', auth: { type: 'apikey', name: 'api key', value: '{{PASSWORD}}', in: 'query' } }, vars, opts).request;
    expect(key.url).toBe('https://example.com/?a=1&api%20key={{PASSWORD:url}}');
    const explicit = prepareRequest(
      { ...newRequest(), url: 'https://example.com', headers: [{ name: 'authorization', value: 'Token x', enabled: true }], auth: { type: 'bearer', token: 'y' } },
      vars,
      opts,
    ).request;
    expect(explicit.headers).toEqual([{ name: 'authorization', value: 'Token x' }]);
    const upload = prepareRequest(
      {
        ...newRequest(),
        method: 'POST',
        url: 'https://example.com',
        body: { type: 'multipart', text: '', path: '', fields: [{ name: 'f', value: 'files/a b.png', enabled: true, file: true }, { name: 'off', value: 'x', enabled: false }] },
        options: { followRedirects: false, timeoutSeconds: 5 },
      },
      vars,
      opts,
    ).request;
    expect(upload.body).toEqual({ type: 'multipart', fields: [{ name: 'f', value: 'C:\\Projects\\api\\files\\a b.png', file: true }] });
    expect([upload.followRedirects, upload.timeoutSeconds, upload.insecure]).toEqual([false, 5, false]);
  });

  it('gives curl usable names for any variable name', () => {
    const vars = new Map([['my.token', { name: 'my.token', value: 'x', source: '.env.local', secret: true }]]);
    const r = prepareRequest({ ...newRequest(), url: 'https://example.com', headers: [{ name: 'A', value: '{{my.token}}', enabled: true }] }, vars, opts).request;
    expect(r.headers).toEqual([{ name: 'A', value: '{{my_token}}' }]);
    expect(r.secrets).toEqual([{ name: 'my_token', value: 'x' }]);
  });

  it('turns the files into editable rows and marks what is overridden', () => {
    const rows = variableRows(files());
    expect(rows).toEqual([
      { name: 'baseUrl', value: 'https://default.example.com', scope: 'shared' },
      { name: 'API_TOKEN', value: 'op://Example Vault/Example API/credential', scope: 'shared' },
      { name: 'PAGE', value: '20', scope: 'shared' },
      { name: 'baseUrl', value: 'https://staging.example.com', scope: 'sharedEnv' },
      { name: 'tenant', value: 'acme-test', scope: 'sharedEnv' },
      { name: 'userId', value: '42', scope: 'mine' },
      { name: 'PASSWORD', value: 'hunter2', scope: 'mine' },
      { name: 'userId', value: '43', scope: 'mineEnv' },
    ]);
    expect([...overriddenRows(rows)].map((r) => `${r.name}/${r.scope}`)).toEqual(['baseUrl/shared', 'userId/mine']);
  });

  it('checks names before saving', () => {
    expect(checkRows([{ name: 'a', value: '', scope: 'shared' }], '')).toBeNull();
    expect(checkRows([{ name: '', value: 'x', scope: 'shared' }], '')).toMatch(/name/);
    expect(checkRows([{ name: 'a b', value: '', scope: 'shared' }], '')).toMatch(/valid/);
    expect(checkRows([{ name: 'a', value: '', scope: 'sharedEnv' }], '')).toMatch(/environment/);
    expect(checkRows([{ name: 'a', value: '1', scope: 'mine' }, { name: 'a', value: '2', scope: 'mine' }], 'dev')).toMatch(/twice in \.env\.local/);
  });

  it('writes only the files that change, keeping their comments', () => {
    const f = { ...files(), dotenv: [{ path: '.env', text: '# shared\nPAGE=20\nOLD=x\n' }, { path: '.env.local', text: 'A=1\n' }] };
    const before = variableRows(f);
    const env = { variables: { baseUrl: 'https://staging.example.com', tenant: 'acme-test' }, choices: {}, protected: true, color: '' };
    const after = [
      ...before.filter((r) => r.name !== 'OLD' && r.name !== 'A'),
      { name: 'TOKEN', value: 'secret value', scope: 'mineEnv' as const },
      { name: 'A', value: '1', scope: 'sharedEnv' as const },
    ];
    expect(variableWrites(before, after, f, env)).toEqual([
      { path: '.env', kind: 'rootFile', text: '# shared\nPAGE=20\n' },
      {
        path: 'environments/staging.json',
        kind: 'environment',
        text: '{\n  "variables": {\n    "baseUrl": "https://staging.example.com",\n    "tenant": "acme-test",\n    "A": "1"\n  },\n  "protected": true\n}\n',
      },
      { path: '.env.local', kind: 'rootFile', text: '' },
      { path: '.env.staging.local', kind: 'rootFile', text: 'TOKEN="secret value"\n' },
    ]);
    expect(variableWrites(before, before, f, env)).toEqual([]);
    expect(scopeFile('mineEnv', 'prod')).toBe('.env.prod.local');
    // Names a teammate added to the file meanwhile (a pull while editing) are kept.
    const pulled = { ...env, variables: { ...env.variables, region: 'eu' } };
    const edited = before.map((r) => (r.name === 'tenant' ? { ...r, value: 'acme' } : r));
    expect(variableWrites(before, edited, f, pulled)[0].text).toContain('"region": "eu"');
  });

  it('fills in variables that use variables', () => {
    const vars = collectVariables({
      env: '',
      environment: {},
      dotenv: [
        { path: '.env', text: 'host=api.example.com\nbase=https://{{host}}/v1\nauth=Bearer {{TOKEN}}\nloop={{loop}}\n' },
        { path: '.env.local', text: 'TOKEN=t0ken\n' },
      ],
    });
    const p = prepareRequest({ ...newRequest(), url: '{{base}}/users', headers: [{ name: 'Authorization', value: '{{auth}}', enabled: true }] }, vars, opts);
    expect(p.request.url).toBe('https://api.example.com/v1/users');
    expect(p.request.headers).toEqual([{ name: 'Authorization', value: 'Bearer {{TOKEN}}' }]);
    expect(p.missing).toEqual([]);
    expect(prepareRequest({ ...newRequest(), url: 'https://example.com/{{loop}}' }, vars, opts).missing).toEqual(['loop']);
  });

  it('encodes an API key that goes into the query', () => {
    const vars = collectVariables({ env: '', environment: {}, dotenv: [{ path: '.env', text: 'KEYNAME=api key\nPLAIN=a&b=c\n' }, { path: '.env.local', text: 'SECRET=x\n' }] });
    const url = (value: string) => prepareRequest({ ...newRequest(), url: 'https://example.com/?a=1', auth: { type: 'apikey', name: '{{KEYNAME}}', value, in: 'query' } }, vars, opts).request.url;
    expect(url('{{PLAIN}}')).toBe('https://example.com/?a=1&api%20key=a%26b%3Dc');
    expect(url('typed in & more')).toBe('https://example.com/?a=1&api%20key=typed%20in%20%26%20more');
    expect(url('{{SECRET}}')).toBe('https://example.com/?a=1&api%20key={{SECRET:url}}');
  });

  it("doesn't hand secrets over under names curl or Windows read", () => {
    const vars = collectVariables({ env: '', environment: {}, dotenv: [{ path: '.env.local', text: 'HTTPS_PROXY=x\ntoken=a\nTOKEN=b\n' }] });
    const doc = { ...newRequest(), url: 'https://example.com', headers: [{ name: 'A', value: '{{HTTPS_PROXY}} {{token}} {{TOKEN}}', enabled: true }] };
    expect(prepareRequest(doc, vars, opts).request.secrets?.map((s) => s.name)).toEqual(['SHELLMAN_HTTPS_PROXY', 'token', 'TOKEN_']);
  });

  it('asks before sending files from outside the folder', () => {
    const req = (path: string) => ({ method: 'POST', url: 'https://example.com', body: { type: 'file' as const, path } });
    expect(filesOutside(req('C:\\Projects\\api\\data\\a.json'), 'C:\\Projects\\api\\')).toEqual([]);
    expect(filesOutside(req('c:/projects/API/b.json'), 'C:\\Projects\\api')).toEqual([]);
    expect(filesOutside(req('C:\\Projects\\api\\..\\..\\Users\\me\\.ssh\\id_ed25519'), 'C:\\Projects\\api')).toHaveLength(1);
    expect(filesOutside(req('C:\\Projects\\api-other\\a.json'), 'C:\\Projects\\api')).toHaveLength(1);
  });

  it('names personal files for any environment', () => {
    expect(localEnvFile('staging')).toBe('.env.staging.local');
    expect(localEnvFile('Prod EU.1')).toBe('.env.Prod_EU_1.local');
  });

  it('finds tokens typed into a request', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh';
    const doc: RequestDoc = {
      ...newRequest(),
      url: 'https://example.com',
      headers: [
        { name: 'Authorization', value: `Bearer ${jwt}`, enabled: true },
        { name: 'X-Api-Key', value: '{{API_KEY}}', enabled: true },
        { name: 'Accept', value: 'application/json', enabled: true },
      ],
      auth: { type: 'basic', username: 'me', password: 'Summer2026!' },
    };
    expect(findSecretLiterals(doc).map((s) => s.where)).toEqual(['Header Authorization', 'Password']);
    // Also in the query, in form fields, and in headers turned off (they are saved all the same).
    const more: RequestDoc = {
      ...newRequest(),
      url: `https://example.com/?page=2&api_key=abcd1234efgh5678ijkl&t=${jwt}`,
      headers: [{ name: 'X-Auth-Token', value: 'abcdefgh12345678', enabled: false }],
      body: { type: 'form', text: '', path: '', fields: [{ name: 'client_secret', value: 's3cr3t-value', enabled: true }] },
    };
    expect(findSecretLiterals(more).map((s) => s.where)).toEqual(['Header X-Auth-Token', 'Query api_key', 'Query t', 'Field client_secret']);
    expect(findSecretLiterals(newRequest())).toEqual([]);
  });
});

describe('secret or not', () => {
  it('decides the file', () => {
    const scope = (perEnv: boolean, secret: boolean, value = 'x') => rowScope({ name: 'A', value, perEnv, secret });
    expect([scope(false, false), scope(true, false), scope(false, true), scope(true, true)]).toEqual(['shared', 'sharedEnv', 'mine', 'mineEnv']);
    // A 1Password reference is secret, but holds no secret: it is shared.
    expect(scope(true, true, 'op://Vault/Item/field')).toBe('sharedEnv');
  });

  it('reads back what was chosen', () => {
    expect(editRow({ name: 'A', value: 'x', scope: 'mineEnv' })).toEqual({ name: 'A', value: 'x', perEnv: true, secret: true, local: true });
    expect(editRow({ name: 'A', value: 'x', scope: 'shared' })).toEqual({ name: 'A', value: 'x', perEnv: false, secret: false });
    expect(editRow({ name: 'A', value: 'op://V/I/f', scope: 'shared' }).secret).toBe(true);
    for (const scope of SCOPES) expect(rowScope(editRow({ name: 'A', value: 'x', scope }))).toBe(scope);
    // Someone's own 1Password reference in .env.local stays theirs, not shared over the team's.
    expect(rowScope(editRow({ name: 'A', value: 'op://Private/Item/field', scope: 'mine' }))).toBe('mine');
  });

  it('hides every secret, whatever its name', () => {
    expect(displayValue({ name: 'userId', value: '42', source: '.env.local', secret: true }, true)).toBe('••••••••');
    expect(displayValue({ name: 'userId', value: '42', source: '.env.local', secret: true }, false)).toBe('42');
    expect(displayValue({ name: 'TOKEN', value: 'op://V/I/f', source: '.env', secret: true }, true)).toBe('op://V/I/f');
  });
});

describe('choices', () => {
  const tenants = [
    { value: 'acme', description: 'Demos' },
    { value: 'globex', description: 'EU data' },
  ];
  const withChoices = (picks: Record<string, string> = {}) => ({
    env: 'staging',
    environment: { region: 'eu' },
    choices: { region: [{ value: 'eu', description: '' }, { value: 'us', description: 'US only' }] },
    dotenv: [
      { path: '.env', text: '# @choice acme -- Demos\n# @choice globex -- EU data\nTENANT=acme\n' },
      { path: '.env.local', text: '# @choice key-one -- mine\n# @choice key-two\nMY_KEY=key-two\n' },
    ],
    picks,
  });

  it('use the value chosen, if it is still one of them', () => {
    expect(collectVariables(withChoices()).get('TENANT')).toEqual({ name: 'TENANT', value: 'acme', source: '.env', secret: false, choices: tenants });
    expect(collectVariables(withChoices({ TENANT: 'globex', region: 'us' })).get('TENANT')?.value).toBe('globex');
    expect(collectVariables(withChoices({ region: 'us' })).get('region')?.value).toBe('us');
    expect(collectVariables(withChoices({ TENANT: 'gone' })).get('TENANT')?.value).toBe('acme');
    // A personal file holds its own choice; the group's picks don't apply to it.
    expect(collectVariables(withChoices({ MY_KEY: 'key-one' })).get('MY_KEY')).toMatchObject({ value: 'key-two', secret: true });
  });

  it('show what the chosen one is for', () => {
    const vars = collectVariables(withChoices({ TENANT: 'globex' }));
    expect(describeVariable('TENANT', vars, true).title).toBe('{{TENANT}} = globex\nEU data\nfrom .env. One of 2 choices: Ctrl+click to switch.');
    expect(currentChoice(vars.get('TENANT')!)).toEqual(tenants[1]);
    expect(choiceLabel(tenants[0], false, true)).toBe('acme — Demos');
    expect(choiceLabel({ value: 'x', description: '' }, true, true)).toBe('••••••••');
    expect(choiceLabel({ value: '', description: 'none' }, false, true)).toBe('(empty) — none');
  });

  it('are edited with the value in use, and kept with the first as the default', () => {
    const rows = variableRows(withChoices());
    expect(rows.find((r) => r.name === 'region')).toEqual({ name: 'region', value: 'eu', scope: 'sharedEnv', choices: [{ value: 'eu', description: '' }, { value: 'us', description: 'US only' }] });
    const edit = rows.map((r) => editRow(r, { TENANT: 'globex', MY_KEY: 'key-one' }));
    expect(edit.map((r) => r.value)).toEqual(['globex', 'eu', 'key-two']);
    // Shared: the file keeps the first one; the one in use is this person's pick. Personal: the file holds it.
    expect(edit.map(varRow).map((r) => r.value)).toEqual(['acme', 'eu', 'key-two']);
    expect(rowPicks(edit)).toEqual({ TENANT: 'globex', region: 'eu' });
    // The editor's copy can change without touching what was read.
    edit[0].choices![0].description = 'changed';
    expect(rows[0].choices![0].description).toBe('Demos');
    // Only 1Password references: secret, but shared.
    const refs = editRow({ name: 'TOKEN', value: 'op://V/a/f', scope: 'shared', choices: [{ value: 'op://V/a/f', description: '' }, { value: 'op://V/b/f', description: '' }] });
    expect([refs.secret, rowScope(refs)]).toEqual([true, 'shared']);
    expect(rowScope({ ...refs, choices: [...refs.choices!, { value: 'literal', description: '' }] })).toBe('mine');
  });

  it('are checked and written', () => {
    const f = withChoices();
    const before = variableRows(f);
    expect(checkRows([{ name: 'A', value: 'x', scope: 'shared', choices: [{ value: 'x', description: '1' }, { value: 'x', description: '2' }] }], '')).toBe('"A" has the choice "x" twice.');
    const after = before.map((r) =>
      r.name === 'TENANT' ? { ...r, choices: [...r.choices!, { value: 'initech', description: 'Load tests' }] } : r.name === 'region' ? { name: 'region', value: 'eu', scope: r.scope } : r,
    );
    const writes = variableWrites(before, after, f, { variables: { region: 'eu' }, choices: f.choices, protected: false, color: '' });
    expect(writes).toEqual([
      { path: '.env', kind: 'rootFile', text: '# @choice acme -- Demos\n# @choice globex -- EU data\n# @choice initech -- Load tests\nTENANT=acme\n' },
      { path: 'environments/staging.json', kind: 'environment', text: '{\n  "variables": {\n    "region": "eu"\n  }\n}\n' },
    ]);
    // Only a description changed: still written.
    const described = before.map((r) => (r.name === 'TENANT' ? { ...r, choices: [tenants[0], { value: 'globex', description: 'EU' }] } : r));
    expect(variableWrites(before, described, f, undefined).map((w) => w.path)).toEqual(['.env']);
  });
});

describe('1Password references', () => {
  it('are found with quotes, spaces or invisible characters around them', () => {
    expect(opRef('op://Vault/Item/field')).toBe('op://Vault/Item/field');
    expect(opRef('"op://Example Vault/API token/credential"')).toBe('op://Example Vault/API token/credential');
    expect(opRef(" \uFEFF'OP://Vault/Item/field' ")).toBe('OP://Vault/Item/field');
    expect(opRef('Bearer op://x')).toBeNull();
    expect(opRef('')).toBeNull();
  });

  it('are passed to 1Password without the quotes', () => {
    const vars = collectVariables({ env: '', environment: {}, dotenv: [{ path: '.env', text: 'apiToken="\\"op://Example Vault/API token/credential\\""\n' }] });
    expect(vars.get('apiToken')).toMatchObject({ value: '"op://Example Vault/API token/credential"', secret: true });
    const r = prepareRequest({ ...newRequest(), url: 'https://example.com', headers: [{ name: 'Authorization', value: '{{apiToken}}', enabled: true }] }, vars, opts).request;
    expect(r.secrets).toEqual([{ name: 'apiToken', value: 'op://Example Vault/API token/credential' }]);
  });
});
