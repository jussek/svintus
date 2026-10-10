#!/usr/bin/env node
/** Official API setup. Credentials are read from the environment and never logged. */
import { setGlobalProxyFromEnv } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Preserve the cloud environment's supported proxy and TLS certificate checks.
setGlobalProxyFromEnv();

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
};
const redact = value => {
  let text = String(value);
  for (const name of ['VERCEL_TOKEN', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_PUBLISHABLE_KEY']) {
    const secret = process.env[name];
    if (secret) text = text.replaceAll(secret, '[redacted]');
  }
  return text
    .replace(/\b(?:sb_secret_|sb_publishable_)[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]');
};

function request(url, token, { method = 'GET', body, headers = {}, allowedStatus = [] } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = httpsRequest(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300 || allowedStatus.includes(status)) {
          resolve({ status, data });
        } else {
          const code = data?.error?.code ?? data?.code ?? 'request_failed';
          const error = new Error(`${method} ${new URL(url).hostname}${new URL(url).pathname}: HTTP ${status} ${redact(code)}`);
          error.code = code;
          error.status = status;
          reject(error);
        }
      });
    });
    req.setTimeout(45_000, () => req.destroy(new Error(`Request timed out: ${new URL(url).hostname}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const metadataPath = process.env.PLATFORM_METADATA_PATH || '/tmp/svintus-platform.json';
const supabaseUrl = new URL(required('SUPABASE_URL'));
if (supabaseUrl.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(supabaseUrl.hostname)) {
  throw new Error('SUPABASE_URL must identify the intended hosted HTTPS Supabase project');
}
const supabaseProjectRef = supabaseUrl.hostname.split('.')[0];
const supabaseToken = required('SUPABASE_ACCESS_TOKEN');
const vercelToken = required('VERCEL_TOKEN');
const supabaseApi = `https://api.supabase.com/v1/projects/${supabaseProjectRef}`;
const databaseQuery = async (query, readOnly = true) => (await request(`${supabaseApi}/database/query`, supabaseToken, {
  method: 'POST', body: { query, read_only: readOnly },
})).data;

async function discover() {
  const projects = (await request('https://api.supabase.com/v1/projects', supabaseToken)).data;
  const supabaseProject = projects.find(project => project.id === supabaseProjectRef);
  if (!supabaseProject) throw new Error('SUPABASE_URL project is not accessible to the supplied access token');
  const vercelProjects = (await request('https://api.vercel.com/v9/projects?limit=100', vercelToken)).data;
  const matches = vercelProjects.projects.filter(project => project.link?.org === 'jussek' && project.link?.repo === 'svintus');
  if (matches.length > 1) throw new Error('Multiple Vercel projects link jussek/svintus; select the intended project before provisioning');
  let vercelProject = matches[0];
  if (!vercelProject) {
    const named = vercelProjects.projects.filter(project => project.name === 'svintus');
    if (named.some(project => project.link && (project.link.org !== 'jussek' || project.link.repo !== 'svintus'))) {
      throw new Error('The existing Vercel svintus project belongs to another repository');
    }
    vercelProject = named[0];
  }
  if (!vercelProject) throw new Error('No Vercel project for svintus found; create/link the intended project first');
  const metadata = {
    supabaseProjectRef,
    vercelProjectId: vercelProject.id,
    vercelTeamId: vercelProject.accountId?.startsWith('team_') ? vercelProject.accountId : null,
    vercelProjectName: vercelProject.name,
    status: 'discovered',
  };
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...metadata, supabaseProjectStatus: supabaseProject.status }));
  return metadata;
}

async function provision() {
  const metadata = await discover();
  const columns = await databaseQuery(`
    select a.attname, format_type(a.atttypid,a.atttypmod) as column_type, a.attnotnull
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    where n.nspname='public' and c.relname='svintus_rooms' order by a.attnum
  `);
  const expected = { code: 'text', state: 'jsonb', sessions: 'jsonb', version: 'integer', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone' };
  if (columns.length && (columns.length !== Object.keys(expected).length || columns.some(column => expected[column.attname] !== column.column_type || !column.attnotnull))) {
    throw new Error('Existing svintus_rooms schema is incompatible; no database changes were made');
  }
  const policies = await databaseQuery("select policyname from pg_policies where schemaname='public' and tablename='svintus_rooms'");
  if (policies.length) throw new Error('Existing svintus_rooms has RLS policies; inspect them before changing private storage');
  const migration = await readFile(fileURLToPath(new URL('../supabase/migrations/20261010000000_rooms.sql', import.meta.url)), 'utf8');
  await databaseQuery(migration, false);
  const privateAccess = await databaseQuery(`
    select c.relrowsecurity as rls_enabled,
      has_table_privilege('anon',c.oid,'SELECT') as anon_select,
      has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_select,
      has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE') as server_access
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='svintus_rooms'
  `);
  if (privateAccess.length !== 1 || !privateAccess[0].rls_enabled || privateAccess[0].anon_select || privateAccess[0].authenticated_select || !privateAccess[0].server_access) {
    throw new Error('Database private access validation failed');
  }
  const restUrl = `${supabaseUrl.origin}/rest/v1/svintus_rooms?select=code&limit=0`;
  await request(restUrl, null, { headers: { apikey: required('SUPABASE_SECRET_KEY') } });
  if (process.env.SUPABASE_PUBLISHABLE_KEY) {
    const publicResult = await request(restUrl, null, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY }, allowedStatus: [401, 403] });
    if (![401, 403].includes(publicResult.status)) throw new Error('Browser key unexpectedly has access to room storage');
  }
  console.log('Supabase room migration and private server access verified.');

  const query = metadata.vercelTeamId ? `?teamId=${encodeURIComponent(metadata.vercelTeamId)}` : '';
  const projectUrl = `https://api.vercel.com/v9/projects/${metadata.vercelProjectId}${query}`;
  await request(projectUrl, vercelToken, {
    method: 'PATCH', body: { framework: 'nextjs', nodeVersion: '24.x', ssoProtection: null },
  });
  const envQuery = metadata.vercelTeamId ? `?teamId=${encodeURIComponent(metadata.vercelTeamId)}&upsert=true` : '?upsert=true';
  const envUrl = `https://api.vercel.com/v10/projects/${metadata.vercelProjectId}/env${envQuery}`;
  const envReadUrl = `https://api.vercel.com/v10/projects/${metadata.vercelProjectId}/env${query}`;
  const existingBindings = (await request(envReadUrl, vercelToken)).data.envs;
  const writableTargets = (key, targets) => targets.filter(target => !existingBindings.some(variable =>
    variable.key === key && variable.target.includes(target) && variable.configurationId));
  // Production/preview secrets stay sensitive. Development uses encrypted values,
  // because Vercel does not support the sensitive type for development targets.
  // Vercel's Supabase integration owns its production bindings. Preserve these
  // working bindings; add the missing targets instead of trying to overwrite
  // managed variables, which the API rejects even when the HTTP status is 201.
  const changes = [
    { key: 'SUPABASE_URL', value: supabaseUrl.origin, target: writableTargets('SUPABASE_URL', ['production', 'preview', 'development']), type: 'encrypted' },
    { key: 'SUPABASE_SECRET_KEY', value: required('SUPABASE_SECRET_KEY'), target: writableTargets('SUPABASE_SECRET_KEY', ['production', 'preview']), type: 'sensitive' },
    { key: 'SUPABASE_SECRET_KEY', value: required('SUPABASE_SECRET_KEY'), target: writableTargets('SUPABASE_SECRET_KEY', ['development']), type: 'encrypted' },
  ].filter(variable => variable.target.length);
  if (changes.length) {
    const update = (await request(envUrl, vercelToken, { method: 'POST', body: changes })).data;
    if (update.failed?.length) {
      throw new Error(`Vercel environment update failed: ${update.failed.map(item => item.error?.code ?? item.code ?? item.key ?? 'unknown').join(', ')}`);
    }
  }
  const verification = (await request(projectUrl, vercelToken)).data;
  const serverBindings = (await request(envReadUrl, vercelToken)).data.envs.filter(variable => ['SUPABASE_URL', 'SUPABASE_SECRET_KEY'].includes(variable.key));
  for (const key of ['SUPABASE_URL', 'SUPABASE_SECRET_KEY']) {
    for (const target of ['production', 'preview', 'development']) {
      if (!serverBindings.some(variable => variable.key === key && variable.target.includes(target))) {
        throw new Error(`Vercel ${key} binding for ${target} missing after update`);
      }
    }
  }
  if (verification.framework !== 'nextjs' || verification.ssoProtection) throw new Error('Vercel Next.js/public game configuration did not persist');
  metadata.status = 'ready-for-deploy';
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  console.log('Vercel Next.js project and server-only environment bindings verified.');
  console.log(JSON.stringify(metadata));
}

async function loadMetadata() {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (metadata.vercelProjectId && metadata.vercelProjectName === 'svintus' && metadata.supabaseProjectRef === supabaseProjectRef) return metadata;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return discover();
}

const teamQuery = metadata => metadata.vercelTeamId ? `?teamId=${encodeURIComponent(metadata.vercelTeamId)}` : '';
const scopedUrl = (path, metadata, extra = {}) => {
  const url = new URL(`https://api.vercel.com${path}`);
  if (metadata.vercelTeamId) url.searchParams.set('teamId', metadata.vercelTeamId);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, String(value));
  return url.toString();
};

async function checkedVercelProject(metadata) {
  const project = (await request(`https://api.vercel.com/v9/projects/${metadata.vercelProjectId}${teamQuery(metadata)}`, vercelToken)).data;
  if (project.name !== 'svintus' || project.link?.org !== 'jussek' || project.link?.repo !== 'svintus') {
    throw new Error('Refusing to deploy: project is not the intended jussek/svintus game');
  }
  return project;
}

async function deploymentSummary(deployment, metadata) {
  const state = deployment.readyState ?? deployment.state ?? 'UNKNOWN';
  const domains = (await request(scopedUrl(`/v9/projects/${metadata.vercelProjectId}/domains`, metadata), vercelToken)).data.domains;
  const stableDomains = domains.filter(domain => !domain.gitBranch && !domain.redirect).map(domain => domain.name);
  const summary = {
    id: deployment.id ?? deployment.uid,
    state,
    url: deployment.url ? `https://${deployment.url}` : null,
    productionUrl: state === 'READY' && stableDomains[0] ? `https://${stableDomains[0]}` : null,
    productionDomains: stableDomains,
    commit: deployment.meta?.githubCommitSha ?? deployment.meta?.sourceCommit ?? metadata.deploymentCommit ?? null,
  };
  if (state === 'ERROR' || state === 'CANCELED') {
    summary.errorCode = deployment.errorCode ?? null;
    summary.errorMessage = deployment.errorMessage ? redact(deployment.errorMessage).slice(0, 1200) : null;
  }
  return summary;
}

function sourceFiles(commit) {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const git = args => execFileSync('git', args, { cwd, maxBuffer: 12 * 1024 * 1024 });
  const paths = git(['ls-tree', '-r', '-z', '--name-only', commit]).toString('utf8').split('\0').filter(Boolean);
  const blocked = /^(?:\.git(?:\/|$)|\.vercel(?:\/|$)|node_modules\/|\.next\/|test-results\/|playwright-report\/|\.env(?!\.example$))/;
  let totalBytes = 0;
  const files = paths.filter(path => !blocked.test(path)).map(file => {
    const data = git(['show', `${commit}:${file}`]);
    totalBytes += data.length;
    return { file, data: data.toString('base64'), encoding: 'base64' };
  });
  if (!files.length || totalBytes > 8 * 1024 * 1024) throw new Error('Source fallback requires a nonempty committed checkout below the 8 MB inline upload limit');
  return files;
}

async function deploy(commit, useFiles = false) {
  if (!/^[a-f0-9]{40}$/i.test(commit ?? '')) throw new Error('deploy requires the full 40-character pushed Git commit SHA');
  const metadata = await loadMetadata();
  const project = await checkedVercelProject(metadata);
  const history = (await request(scopedUrl('/v6/deployments', metadata, { projectId: metadata.vercelProjectId, target: 'production', limit: 20 }), vercelToken)).data.deployments;
  const matching = history.find(deployment => (deployment.meta?.githubCommitSha === commit || deployment.meta?.sourceCommit === commit) && ['QUEUED', 'INITIALIZING', 'BUILDING', 'READY'].includes(deployment.readyState ?? deployment.state));
  let deployment;
  if (matching && !useFiles) {
    deployment = (await request(scopedUrl(`/v13/deployments/${matching.uid ?? matching.id}`, metadata), vercelToken)).data;
  } else {
    // Production automatically assigns the stable domains already attached to
    // this project. Public access was configured by provision, not by a bypass.
    if (project.framework !== 'nextjs' || project.nodeVersion !== '24.x' || project.ssoProtection) {
      await request(scopedUrl(`/v9/projects/${metadata.vercelProjectId}`, metadata), vercelToken, {
        method: 'PATCH', body: { framework: 'nextjs', nodeVersion: '24.x', ssoProtection: null },
      });
    }
    const body = {
      name: metadata.vercelProjectName,
      project: metadata.vercelProjectId,
      target: 'production',
      meta: { sourceCommit: commit },
      ...(useFiles
        ? { files: sourceFiles(commit) }
        : { gitSource: { type: 'github', repoId: String(project.link.repoId), ref: commit, sha: commit } }),
    };
    try {
      deployment = (await request(scopedUrl('/v13/deployments', metadata), vercelToken, { method: 'POST', body })).data;
    } catch (error) {
      // A Git source failure has a supported, explicit fallback using only files
      // from that exact committed tree; no local .env or ignored files are sent.
      if (!useFiles && ['git_repo_not_found', 'git_repository_not_found', 'github_repository_not_found', 'git_source_not_found', 'git_permission_denied', 'invalid_git_source', 'commit_not_found', 'git_commit_not_found', 'git_branch_not_found', 'invalid_repo_id'].includes(error.code)) {
        console.log(`Git source unavailable (${redact(error.code)}); uploading the exact committed source tree.`);
        deployment = (await request(scopedUrl('/v13/deployments', metadata), vercelToken, {
          method: 'POST', body: { ...body, gitSource: undefined, files: sourceFiles(commit) },
        })).data;
      } else throw error;
    }
  }
  if (deployment.projectId !== metadata.vercelProjectId) throw new Error('Deployment does not belong to the intended game project');
  const summary = await deploymentSummary(deployment, metadata);
  Object.assign(metadata, { deploymentId: summary.id, deploymentCommit: commit, deploymentUrl: summary.url, status: summary.state });
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, reused: Boolean(matching && !useFiles) }));
}

async function status(id) {
  const metadata = await loadMetadata();
  await checkedVercelProject(metadata);
  id ??= metadata.deploymentId;
  if (!id) {
    const deployments = (await request(scopedUrl('/v6/deployments', metadata, { projectId: metadata.vercelProjectId, target: 'production', limit: 1 }), vercelToken)).data.deployments;
    id = deployments[0]?.uid ?? deployments[0]?.id;
  }
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('No valid deployment ID found; run deploy <commit> first');
  const deployment = (await request(scopedUrl(`/v13/deployments/${id}`, metadata), vercelToken)).data;
  if (deployment.projectId !== metadata.vercelProjectId) throw new Error('Refusing to read another project deployment');
  const summary = await deploymentSummary(deployment, metadata);
  Object.assign(metadata, { deploymentId: summary.id, deploymentUrl: summary.url, productionUrl: summary.productionUrl, status: summary.state });
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(summary));
  if (summary.state === 'ERROR') {
    const events = (await request(scopedUrl(`/v3/deployments/${id}/events`, metadata, { direction: 'backward', limit: 30 }), vercelToken)).data;
    const logs = (Array.isArray(events) ? events : events?.events ?? [])
      .map(event => event.text ?? event.payload?.text ?? '')
      .filter(Boolean).slice(-12).map(line => redact(line).slice(0, 1000));
    if (logs.length) console.log(JSON.stringify({ buildLogs: logs }));
    process.exitCode = 1;
  }
}

try {
  const command = process.argv[2] || 'discover';
  if (command === 'discover') await discover();
  else if (command === 'provision') await provision();
  else if (command === 'deploy') await deploy(process.argv[3], process.argv.includes('--files'));
  else if (command === 'status') await status(process.argv[3]);
  else throw new Error('Usage: node scripts/platform.mjs discover|provision|deploy <commit> [--files]|status [deploymentId]');
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}
