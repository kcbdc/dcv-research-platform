import test from 'node:test';
import assert from 'node:assert/strict';
import { testOfficialConnectorSafe, explainConnectorError } from '../src/lib/official_sources.js';

const ERR = '{ "OpenAPI_ServiceResponse": { "cmmMsgHeader": { "errMsg": "APPLICATION_ERROR", "returnAuthMsg": "어플리케이션 에러", "returnReasonCode": "01" } } }';
const OK = JSON.stringify({ response: { header: { resultCode: '00' }, body: { totalCount: 2, numOfRows: 10, items: { item: [
  { BSNSYEAR: '2022', REALM_CODE: '10', SECT_CODE: '011', BGAMT: '571' },
  { BSNSYEAR: '2022', REALM_CODE: '10', SECT_CODE: '012', BGAMT: '12' }] } } } });

test('BOJO: data.go.kr APPLICATION_ERROR is retried and then labelled with code + hint', async () => {
  const old = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response(ERR, { status: 500 }); };
    const r = await testOfficialConnectorSafe({ BOJO_API_KEY: 'k' }, 'bojo_openapi', { query: { bsnsyear: '2022', numOfRows: 10, pageNo: 1 } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'datago_application_error');
    assert.match(r.error, /DATAGO\[APPLICATION_ERROR\/01\]/);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = old; }
});

test('BOJO: recovers when a retry succeeds', async () => {
  const old = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return calls < 2 ? new Response(ERR, { status: 500 }) : new Response(OK, { status: 200 }); };
    const r = await testOfficialConnectorSafe({ BOJO_API_KEY: 'k' }, 'bojo_openapi', { query: { bsnsyear: '2022', numOfRows: 10, pageNo: 1 } });
    assert.equal(r.ok, true); assert.equal(r.fetched, 2); assert.equal(r.first_period, '2022');
  } finally { globalThis.fetch = old; }
});

test('BOJO: gateway error returned with HTTP 200 (XML) is also explained', async () => {
  const old = globalThis.fetch;
  const xml = '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
  try {
    globalThis.fetch = async () => new Response(xml, { status: 200 });
    const r = await testOfficialConnectorSafe({ BOJO_API_KEY: 'k' }, 'bojo_openapi', {});
    assert.equal(r.ok, false); assert.match(r.error, /BOJO_API_ERROR:DATAGO\[SERVICE ERROR\/30\]/);
  } finally { globalThis.fetch = old; }
});

test('explainConnectorError maps data.go.kr codes', () => {
  assert.equal(explainConnectorError(new Error('HTTP_500:apis.data.go.kr:DATAGO[APPLICATION_ERROR/01]:x')).code, 'datago_application_error');
  assert.equal(explainConnectorError(new Error('BOJO_API_ERROR:DATAGO[SERVICE_KEY_IS_NOT_REGISTERED_ERROR/30]:x')).code, 'datago_key_invalid');
});
