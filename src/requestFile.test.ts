import { describe, expect, it } from 'vitest';
import {
  environmentFileName,
  joinUrl,
  newRequest,
  parseEnvironment,
  parseRequest,
  readRequest,
  requestFileName,
  requestFolder,
  requestName,
  serializeEnvironment,
  serializeRequest,
  splitUrl,
  type RequestDoc,
} from './requestFile';

describe('request files', () => {
  it('writes a small file: defaults left out, keys in a fixed order', () => {
    const doc: RequestDoc = { ...newRequest(), url: '{{baseUrl}}/users' };
    expect(serializeRequest(doc)).toBe('{\n  "method": "GET",\n  "url": "{{baseUrl}}/users"\n}\n');
  });

  it('round-trips every field', () => {
    const doc: RequestDoc = {
      method: 'POST',
      url: '{{baseUrl}}/users?limit=20',
      headers: [
        { name: 'Accept', value: 'application/json', enabled: true },
        { name: 'X-Debug', value: '1', enabled: false },
      ],
      auth: { type: 'bearer', token: '{{API_TOKEN}}' },
      body: { type: 'json', text: '{\n  "name": "Test User"\n}', fields: [], path: '' },
      options: { timeoutSeconds: 60, insecure: true },
      notes: 'Creates a user.',
    };
    const text = serializeRequest(doc);
    expect(parseRequest(text)).toEqual(doc);
    expect(Object.keys(JSON.parse(text))).toEqual(['method', 'url', 'headers', 'auth', 'body', 'options', 'notes']);
    expect(JSON.parse(text).headers).toEqual([{ name: 'Accept', value: 'application/json' }, { name: 'X-Debug', value: '1', enabled: false }]);
    expect(serializeRequest(parseRequest(text))).toBe(text);
  });

  it('keeps form fields and files', () => {
    const doc: RequestDoc = {
      ...newRequest(),
      method: 'POST',
      body: { type: 'multipart', text: '', path: '', fields: [{ name: 'note', value: 'hi', enabled: true }, { name: 'upload', value: 'files/a.png', enabled: true, file: true }] },
    };
    expect(parseRequest(serializeRequest(doc)).body.fields).toEqual(doc.body.fields);
    expect(JSON.parse(serializeRequest({ ...newRequest(), body: { type: 'file', text: 'x', fields: [], path: 'data.bin' } })).body).toEqual({ type: 'file', path: 'data.bin' });
  });

  it('tells an unreadable file from a request with defaults', () => {
    expect(readRequest('<<<<<<< HEAD\n{"method":"GET"}')).toBeNull();
    expect(readRequest('{}')).toEqual(newRequest());
    // Line endings and key order don't make a file different: what counts is what it says.
    const crlf = '{\r\n  "url": "https://example.com",\r\n  "method": "GET"\r\n}\r\n';
    expect(serializeRequest(readRequest(crlf)!)).toBe('{\n  "method": "GET",\n  "url": "https://example.com"\n}\n');
  });

  it('loads broken or foreign files with defaults', () => {
    expect(parseRequest('not json')).toEqual(newRequest());
    expect(parseRequest('[]')).toEqual(newRequest());
    const r = parseRequest('﻿{"method":"get x","url":7,"headers":[{"name":"A"},"junk"],"auth":{"type":"oauth1"},"body":{"type":"graphql"},"options":{"timeoutSeconds":-1},"extra":true}');
    expect(r.method).toBe('GET');
    expect(r.url).toBe('');
    expect(r.headers).toEqual([{ name: 'A', value: '', enabled: true }]);
    expect(r.auth).toEqual({ type: 'none' });
    expect(r.body.type).toBe('none');
    expect(r.options).toEqual({});
    expect(parseRequest('{"method":"patch"}').method).toBe('PATCH');
  });

  it('splits and joins the query for the Params table', () => {
    const u = splitUrl('{{baseUrl}}/users?limit=20&flag&q={{term}}#top');
    expect(u).toEqual({
      base: '{{baseUrl}}/users',
      params: [
        { name: 'limit', value: '20', enabled: true },
        { name: 'flag', value: '', enabled: true },
        { name: 'q', value: '{{term}}', enabled: true },
      ],
      hash: '#top',
    });
    expect(joinUrl(u.base, u.params, u.hash)).toBe('{{baseUrl}}/users?limit=20&flag&q={{term}}#top');
    expect(joinUrl('https://example.com/x', [{ name: '', value: 'x', enabled: true }, { name: 'a', value: '1', enabled: false }])).toBe('https://example.com/x');
    expect(splitUrl('https://example.com')).toEqual({ base: 'https://example.com', params: [], hash: '' });
  });

  it('names and paths', () => {
    expect(requestName('users/list-users.request.json')).toBe('list-users');
    expect(requestName('Create.REQUEST.JSON')).toBe('Create');
    expect(requestFolder('users/admin/x.request.json')).toBe('users/admin');
    expect(requestFolder('x.request.json')).toBe('');
    expect(requestFileName('Get user: by id?')).toBe('Get user- by id-.request.json');
    expect(requestFileName('  ...  ')).toBe('request.request.json');
  });

  it('environments', () => {
    const env = parseEnvironment('{"variables":{"baseUrl":"https://staging.example.com","port":8080,"x":null},"protected":true}');
    expect(env).toEqual({ variables: { baseUrl: 'https://staging.example.com', port: '8080' }, protected: true, color: '' });
    expect(serializeEnvironment(env)).toBe('{\n  "variables": {\n    "baseUrl": "https://staging.example.com",\n    "port": "8080"\n  },\n  "protected": true\n}\n');
    expect(parseEnvironment('oops')).toEqual({ variables: {}, protected: false, color: '' });
    expect(environmentFileName('Production EU')).toBe('production-eu');
    expect(environmentFileName('***')).toBe('environment');
  });
});
