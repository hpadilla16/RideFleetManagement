export const base = process.env.API_BASE || 'http://localhost:4000/api';

export async function api(method, path, token, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text || null; }
  return { ok: res.ok, status: res.status, data };
}

export async function login(email, password = 'TempPass123!') {
  const r = await api('POST', '/auth/login', null, { email, password });
  if (!r.ok) throw new Error(`login failed ${email} ${r.status}`);
  return r.data;
}

export function summary(step, results, diagnostics = {}) {
  return {
    step,
    summary: {
      total: results.length,
      passed: results.filter((x) => x.pass).length,
      failed: results.filter((x) => !x.pass).length
    },
    results,
    diagnostics
  };
}