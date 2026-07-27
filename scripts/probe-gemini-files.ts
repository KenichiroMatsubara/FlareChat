import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const REQUEST_TIMEOUT_MS = 90_000;
const PROCESSING_TIMEOUT_MS = 60_000;

interface Fixture {
  label: string;
  path: string;
  mime: string;
  pythonHint: string;
}

interface GeminiFile {
  name: string;
  uri: string;
  state?: string;
  error?: unknown;
}

interface ProbeResult {
  requestSucceeded: boolean;
  usedCodeExecution: boolean;
  detail: string;
}

interface FixtureResult {
  label: string;
  uploadSucceeded: boolean;
  ordinary: ProbeResult;
  codeExecution: ProbeResult;
}

const fixturePath = (name: string): string => fileURLToPath(
  new URL(`../fixtures/gemini-file-probe/${name}`, import.meta.url),
);

const FIXTURES: Fixture[] = [
  {
    label: 'PDF',
    path: fixturePath('event-invitation.pdf'),
    mime: 'application/pdf',
    pythonHint: 'Use pypdf or pdfplumber.',
  },
  {
    label: 'Word (DOCX)',
    path: fixturePath('event-invitation.docx'),
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    pythonHint: 'Use python-docx or unzip the OOXML package.',
  },
  {
    label: 'Excel (XLSX)',
    path: fixturePath('event-invitation.xlsx'),
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pythonHint: 'Use openpyxl or pandas; do not request CSV conversion.',
  },
];

const EMPTY_PROBE: ProbeResult = {
  requestSucceeded: false,
  usedCodeExecution: false,
  detail: 'Not attempted because upload failed',
};

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly response: unknown,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const readString = (record: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
};

const parseJson = (text: string): unknown => {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const errorMessage = (value: unknown): string => {
  if (!isRecord(value)) return typeof value === 'string' ? value : 'Unknown API error';
  const nested = value.error;
  if (isRecord(nested) && typeof nested.message === 'string') return nested.message;
  if (typeof value.message === 'string') return value.message;
  return JSON.stringify(value);
};

const apiFetch = async (url: string, apiKey: string, init: RequestInit): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set('x-goog-api-key', apiKey);

  const response = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.ok) return response;

  const body = parseJson(await response.text());
  throw new ApiError(`HTTP ${response.status}: ${errorMessage(body)}`, response.status, body);
};

const apiJson = async (
  url: string,
  apiKey: string,
  init: RequestInit,
): Promise<unknown> => {
  const response = await apiFetch(url, apiKey, init);
  return parseJson(await response.text());
};

const unwrapFile = (value: unknown): GeminiFile => {
  const topLevel = isRecord(value) ? value : {};
  const candidate = isRecord(topLevel.file) ? topLevel.file : topLevel;
  const name = readString(candidate, 'name');
  const uri = readString(candidate, 'uri');
  if (!name || !uri) {
    throw new Error(`Files API returned an unexpected response: ${JSON.stringify(value)}`);
  }
  return {
    name,
    uri,
    state: readString(candidate, 'state'),
    error: candidate.error,
  };
};

const uploadFile = async (
  fixture: Fixture,
  bytes: Uint8Array<ArrayBuffer>,
  apiKey: string,
): Promise<GeminiFile> => {
  const startResponse = await apiFetch(`${API_BASE}/upload/v1beta/files`, apiKey, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-upload-protocol': 'resumable',
      'x-goog-upload-command': 'start',
      'x-goog-upload-header-content-length': String(bytes.byteLength),
      'x-goog-upload-header-content-type': fixture.mime,
    },
    body: JSON.stringify({ file: { display_name: basename(fixture.path) } }),
  });

  const uploadUrl = startResponse.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Files API did not return x-goog-upload-url.');

  const uploadResponse = await apiFetch(uploadUrl, apiKey, {
    method: 'POST',
    headers: {
      'content-length': String(bytes.byteLength),
      'content-type': fixture.mime,
      'x-goog-upload-offset': '0',
      'x-goog-upload-command': 'upload, finalize',
    },
    body: bytes,
  });
  return unwrapFile(parseJson(await uploadResponse.text()));
};

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds));
};

const waitUntilActive = async (file: GeminiFile, apiKey: string): Promise<GeminiFile> => {
  let current = file;
  const deadline = Date.now() + PROCESSING_TIMEOUT_MS;

  while (current.state === 'PROCESSING' && Date.now() < deadline) {
    await sleep(1_000);
    current = unwrapFile(await apiJson(`${API_BASE}/v1beta/${current.name}`, apiKey, {
      method: 'GET',
    }));
  }

  if (current.state === 'PROCESSING') {
    throw new Error(`File processing did not finish within ${PROCESSING_TIMEOUT_MS / 1_000} seconds.`);
  }
  if (current.state === 'FAILED') {
    throw new Error(`Gemini file processing failed: ${JSON.stringify(current.error)}`);
  }
  return current;
};

const responseParts = (value: unknown): Array<Record<string, unknown>> => {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return [];
  const candidate = value.candidates[0];
  if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) return [];
  return candidate.content.parts.filter(isRecord);
};

const printResponse = (value: unknown): boolean => {
  const parts = responseParts(value);
  let usedCodeExecution = false;

  for (const part of parts) {
    if (typeof part.text === 'string') {
      console.log('\nGemini text:');
      console.log(part.text.trim());
    }

    const executableCode = isRecord(part.executableCode)
      ? part.executableCode
      : isRecord(part.executable_code) ? part.executable_code : undefined;
    if (executableCode) {
      usedCodeExecution = true;
      console.log('\nExecuted code:');
      console.log(readString(executableCode, 'code') ?? JSON.stringify(executableCode, null, 2));
    }

    const executionResult = isRecord(part.codeExecutionResult)
      ? part.codeExecutionResult
      : isRecord(part.code_execution_result) ? part.code_execution_result : undefined;
    if (executionResult) {
      usedCodeExecution = true;
      console.log('\nCode execution result:');
      console.log(JSON.stringify(executionResult, null, 2));
    }
  }

  if (parts.length === 0) console.log(JSON.stringify(value, null, 2));
  return usedCodeExecution;
};

const runProbe = async (
  fixture: Fixture,
  file: GeminiFile,
  apiKey: string,
  model: string,
  codeExecution: boolean,
): Promise<ProbeResult> => {
  console.log(`\n--- ${codeExecution ? 'Code Execution enabled' : 'Ordinary file reference'} ---`);
  const requestedFields = [
    'test ID',
    'event title',
    'date',
    'start time',
    'end time',
    'time zone',
    'location',
    'organizer',
    'verification code',
  ].join(', ');
  const prompt = codeExecution
    ? [
        `You must use Python code execution to inspect the attached ${fixture.label} file.`,
        fixture.pythonHint,
        `Extract these exact fields: ${requestedFields}.`,
        'Do not infer missing values and briefly state which Python library opened the file.',
      ].join(' ')
    : [
        `Inspect the attached ${fixture.label} file directly without code execution.`,
        `Extract these exact fields: ${requestedFields}.`,
        'Do not infer missing values.',
      ].join(' ');

  try {
    const response = await apiJson(
      `${API_BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      apiKey,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              { text: prompt },
              { file_data: { mime_type: fixture.mime, file_uri: file.uri } },
            ],
          }],
          ...(codeExecution ? { tools: [{ code_execution: {} }] } : {}),
        }),
      },
    );
    const usedCodeExecution = printResponse(response);
    const detail = codeExecution
      ? `request succeeded; Python ${usedCodeExecution ? 'was' : 'was not'} invoked`
      : 'request succeeded';
    console.log(`\nResult: ${detail}`);
    return { requestSucceeded: true, usedCodeExecution, detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`Result: request failed (${detail})`);
    if (error instanceof ApiError) {
      console.log(`Response: ${JSON.stringify(error.response, null, 2)}`);
    }
    return { requestSucceeded: false, usedCodeExecution: false, detail };
  }
};

const deleteFile = async (file: GeminiFile, apiKey: string): Promise<void> => {
  await apiFetch(`${API_BASE}/v1beta/${file.name}`, apiKey, { method: 'DELETE' });
};

const runFixture = async (
  fixture: Fixture,
  apiKey: string,
  model: string,
): Promise<FixtureResult> => {
  console.log(`\n\n========== ${fixture.label} ==========`);
  const fileStat = await stat(fixture.path);
  if (!fileStat.isFile()) throw new Error(`Fixture is not a regular file: ${fixture.path}`);
  const bytes = Uint8Array.from(await readFile(fixture.path));
  console.log(`Fixture: ${fixture.path}`);
  console.log(`Size: ${bytes.byteLength} bytes`);
  console.log(`MIME: ${fixture.mime}`);
  console.log('\n--- Files API upload ---');

  let uploaded: GeminiFile | undefined;
  try {
    uploaded = await uploadFile(fixture, bytes, apiKey);
    uploaded = await waitUntilActive(uploaded, apiKey);
    console.log(`Upload succeeded: ${uploaded.name} (state: ${uploaded.state ?? 'not returned'})`);
    const ordinary = await runProbe(fixture, uploaded, apiKey, model, false);
    const codeExecution = await runProbe(fixture, uploaded, apiKey, model, true);
    return { label: fixture.label, uploadSucceeded: true, ordinary, codeExecution };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`Upload/processing failed: ${detail}`);
    if (error instanceof ApiError) {
      console.log(`Response: ${JSON.stringify(error.response, null, 2)}`);
    }
    return {
      label: fixture.label,
      uploadSucceeded: false,
      ordinary: { ...EMPTY_PROBE },
      codeExecution: { ...EMPTY_PROBE },
    };
  } finally {
    if (uploaded && process.env.GEMINI_KEEP_FILE !== '1') {
      try {
        await deleteFile(uploaded, apiKey);
        console.log(`Deleted uploaded file: ${uploaded.name}`);
      } catch (error) {
        console.warn(`Could not delete ${uploaded.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
};

const status = (result: ProbeResult): string => {
  if (!result.requestSucceeded) return 'FAILED';
  if (result.usedCodeExecution) return 'SUCCEEDED (Python used)';
  return 'SUCCEEDED';
};

const printUsage = (): void => {
  console.log([
    'Usage:',
    '  npm run probe:gemini-files',
    '',
    'You will be prompted once for the Gemini API key.',
    'The bundled PDF, DOCX, and XLSX fixtures are tested automatically.',
    '',
    'Optional environment variables:',
    `  GEMINI_MODEL="${DEFAULT_MODEL}"  Model to test`,
    '  GEMINI_KEEP_FILE=1               Keep uploaded Files API objects',
  ].join('\n'));
};

const main = async (): Promise<void> => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY was not provided by the launcher.');
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  console.log(`Gemini file probe: PDF / DOCX / XLSX`);
  console.log(`Model: ${model}`);

  const results: FixtureResult[] = [];
  for (const fixture of FIXTURES) {
    results.push(await runFixture(fixture, apiKey, model));
  }

  console.log('\n\n========== FINAL SUMMARY ==========');
  for (const result of results) {
    console.log(`${result.label}`);
    console.log(`  Files API upload: ${result.uploadSucceeded ? 'SUCCEEDED' : 'FAILED'}`);
    console.log(`  Ordinary reference: ${status(result.ordinary)}`);
    console.log(`  Code Execution: ${status(result.codeExecution)}`);
  }

  if (!results.some((result) => result.uploadSucceeded)) process.exitCode = 1;
};

main().catch((error: unknown) => {
  console.error(`Probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
