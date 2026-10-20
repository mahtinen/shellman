import { describe, expect, it } from 'vitest';
import { importCollection, importEnvironment, importGlobals, isPostmanEnvironment, isPostmanGlobals } from './postman';

const collection = {
  info: { name: 'Example API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{API_TOKEN}}', type: 'string' }] },
  variable: [
    { key: 'baseUrl', value: 'https://api.example.com' },
    { key: 'clientSecret', value: 's3cr3t-value' },
  ],
  item: [
    {
      name: 'Users',
      item: [
        {
          name: 'List users',
          request: { method: 'GET', header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Old', value: '1', disabled: true }], url: { raw: '{{baseUrl}}/users?limit=20' } },
        },
        {
          name: 'Create user',
          request: {
            method: 'POST',
            header: [],
            body: { mode: 'raw', raw: '{"name":"Test"}', options: { raw: { language: 'json' } } },
            url: '{{baseUrl}}/users',
            description: 'Creates a user.',
          },
          event: [{ listen: 'test', script: { exec: ['pm.test()'] } }],
        },
        { name: 'List users', request: { method: 'GET', url: '{{baseUrl}}/users' } },
      ],
    },
    {
      name: 'Login: admin',
      request: {
        method: 'POST',
        auth: { type: 'basic', basic: [{ key: 'username', value: 'admin' }, { key: 'password', value: 'Summer2026!' }] },
        body: { mode: 'urlencoded', urlencoded: [{ key: 'grant_type', value: 'password' }] },
        url: { protocol: 'https', host: ['auth', 'example', 'com'], path: ['token'], query: [{ key: 'a', value: '1' }] },
      },
    },
    {
      name: 'Upload',
      request: {
        method: 'POST',
        auth: { type: 'noauth' },
        header: [{ key: 'X-Api-Key', value: 'k_9f8e7d6c5b4a' }],
        body: { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: 'C:\\Users\\me\\a.png' }, { key: 'note', value: '{{$guid}}', type: 'text' }] },
        url: '{{baseUrl}}/upload',
      },
    },
  ],
};

describe('Postman import', () => {
  it('turns a collection into request files', () => {
    const r = importCollection(collection);
    expect(r.name).toBe('Example API');
    expect(r.requests.map((x) => x.path)).toEqual([
      'Users/List users.request.json',
      'Users/Create user.request.json',
      'Users/List users (2).request.json',
      'Login- admin.request.json',
      'Upload.request.json',
    ]);
    const [list, create, , login, upload] = r.requests.map((x) => x.doc);
    expect(list).toMatchObject({ method: 'GET', url: '{{baseUrl}}/users?limit=20', auth: { type: 'bearer', token: '{{API_TOKEN}}' } });
    expect(list.headers).toEqual([
      { name: 'Accept', value: 'application/json', enabled: true },
      { name: 'X-Old', value: '1', enabled: false },
    ]);
    expect(create.body).toMatchObject({ type: 'json', text: '{"name":"Test"}' });
    expect(create.notes).toBe('Creates a user.');
    expect(login.url).toBe('https://auth.example.com/token?a=1');
    expect(login.auth).toEqual({ type: 'basic', username: 'admin', password: '{{PASSWORD}}' });
    expect(login.body).toMatchObject({ type: 'form', fields: [{ name: 'grant_type', value: 'password', enabled: true }] });
    expect(upload.auth).toEqual({ type: 'none' });
    expect(upload.headers).toEqual([{ name: 'X-Api-Key', value: '{{X_API_KEY}}', enabled: true }]);
    expect(upload.body.fields[0]).toEqual({ name: 'file', value: 'C:\\Users\\me\\a.png', enabled: true, file: true });
  });

  it('keeps secrets out of the shared files', () => {
    const r = importCollection(collection);
    expect(r.shared).toEqual([{ name: 'baseUrl', value: 'https://api.example.com' }]);
    expect(r.personal).toEqual([
      { name: 'clientSecret', value: 's3cr3t-value' },
      { name: 'PASSWORD', value: 'Summer2026!' },
      { name: 'X_API_KEY', value: 'k_9f8e7d6c5b4a' },
    ]);
    expect(JSON.stringify(r.requests)).not.toMatch(/Summer2026|k_9f8e7d6c5b4a/);
    // A name the folder already uses for another value isn't taken over; the same value is reused.
    const again = importCollection(collection, new Map([['PASSWORD', 'mine'], ['MY_KEY', 'k_9f8e7d6c5b4a']]));
    expect(again.personal.map((e) => e.name)).toEqual(['clientSecret', 'PASSWORD_2']);
    expect(JSON.stringify(again.requests)).toContain('{{MY_KEY}}');
    expect(r.warnings).toEqual(["Users / Create user: scripts aren't imported", "Upload: Postman's dynamic variables ({{$guid}}, {{$timestamp}}, …) aren't supported"]);
  });

  it('turns an environment into an environment file', () => {
    const env = importEnvironment({
      name: 'Production EU',
      values: [
        { key: 'baseUrl', value: 'https://api.example.com', type: 'default', enabled: true },
        { key: 'clientId', value: 'abc', type: 'secret', enabled: true },
        { key: 'API_TOKEN', value: 'xyz', type: 'default', enabled: true },
        { key: 'off', value: '1', enabled: false },
      ],
      _postman_variable_scope: 'environment',
    });
    expect(env).toEqual({
      file: 'production-eu',
      name: 'Production EU',
      doc: { variables: { baseUrl: 'https://api.example.com' }, protected: true, color: '' },
      personal: [
        { name: 'clientId', value: 'abc' },
        { name: 'API_TOKEN', value: 'xyz' },
      ],
    });
  });

  it('puts globals into .env, and secret ones into .env.local', () => {
    const globals = {
      id: 'g1',
      values: [
        { key: 'tenant', value: 'acme', type: 'default', enabled: true },
        { key: 'sessionToken', value: 'stale', type: 'default', enabled: true },
        { key: 'clientId', value: 'abc', type: 'secret', enabled: true },
        { key: 'old', value: '1', enabled: false },
      ],
      _postman_variable_scope: 'globals',
    };
    expect(isPostmanGlobals(globals) && !isPostmanEnvironment(globals)).toBe(true);
    expect(importGlobals(globals)).toEqual({
      shared: [{ name: 'tenant', value: 'acme' }],
      personal: [
        { name: 'sessionToken', value: 'stale' },
        { name: 'clientId', value: 'abc' },
      ],
    });
    expect(() => importGlobals({ values: [], _postman_variable_scope: 'environment' })).toThrow(/globals/);
  });

  it('refuses other files', () => {
    expect(() => importCollection({ values: [] })).toThrow(/collection/);
    expect(() => importEnvironment(collection)).toThrow(/environment/);
  });
});
