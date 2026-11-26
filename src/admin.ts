/**
 * Admin CLI. Works on the database directly (RELAY_DB, default ./data/relay.db),
 * so run it where the relay runs. Every change gets an audit row with actor `cli`.
 *
 *   relay owner add <id> --name <name> [--telegram <user id>] [--tz <IANA zone>]
 *   relay owner list
 *   relay owner console <id> [--label <label>] [--read-only]   (console token, printed once)
 *   relay room add <name> [--title <text>] [--team <id>]
 *   relay room team <room> <team|none>
 *   relay room list
 *   relay team add <id> --name <name> [--gate on|off]
 *   relay team list
 *   relay team rename <team> --name <name>
 *   relay team member <team> <owner> [--role admin|member] [--remove] [--from-invite <display name>]
 *   relay team gate <team> on|off
 *   relay team invite <team> --name <display name> [--note <text>]
 *   relay team uninvite <team> --name <display name>
 *   relay machine add <id> --owner <owner> --name <display>   (strict default policy)
 *   relay machine list
 *   relay machine policy <id> [--json '<policy json>']   (print, or replace: defaults + the given fields)
 *   relay machine kill <id> on|off
 *   relay token create <label> --owner <id> --grant peer:<room>:rw [--grant approval:<scope>:w ...]
 *     (`token add` is the same; `--grants` is the same as `--grant`; a worker token is --grant machine:<id>:rw)
 *   relay token grants <label> --grant ... (replaces the grants)
 *   relay token list [--all]
 *   relay token revoke <label>
 *   relay audit [--limit N]
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb } from './db.ts';
import { loadConfig } from './config.ts';
import { createRelay } from './relay.ts';
import { parseGrantSpec, type Grant } from './grants.ts';
import { DEFAULT_POLICY, type MachineView } from './tasks/service.ts';

function usage(): never {
  console.error(
    [
      'usage:',
      '  relay owner add <id> --name <name> [--telegram <user id>] [--tz <zone>]',
      '  relay owner list',
      '  relay owner console <id> [--label <label>] [--read-only]',
      '  relay room add <name> [--title <text>] [--team <id>]',
      '  relay room team <room> <team|none>',
      '  relay room list',
      '  relay team add <id> --name <name> [--gate on|off]',
      '  relay team list',
      '  relay team rename <team> --name <name>',
      '  relay team member <team> <owner> [--role admin|member] [--remove] [--from-invite <name>]',
      '  relay team gate <team> on|off',
      '  relay team invite <team> --name <display name> [--note <text>]',
      '  relay team uninvite <team> --name <display name>',
      '  relay machine add <id> --owner <owner> --name <display>',
      '  relay machine list',
      "  relay machine policy <id> [--json '<policy json>']",
      '  relay machine kill <id> on|off',
      '  relay token create|add <label> --owner <id> --grant <kind:name:r|w|rw> [--grant ...]',
      '  relay token grants <label> --grant ... ',
      '  relay token list [--all]',
      '  relay token revoke <label>',
      '  relay audit [--limit N]',
    ].join('\n'),
  );
  process.exit(2);
}

/** Run one admin command; `args` are the words after the program name. */
export function runAdmin(args: readonly string[]): void {
  const argv = args;
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) (flags[key] ??= []).push('true');
      else {
        (flags[key] ??= []).push(next);
        i++;
      }
    } else positional.push(a);
  }
  const flag = (k: string) => flags[k]?.at(-1);
  const grantsOf = (): Grant[] => [...(flags.grant ?? []), ...(flags.grants ?? [])].map(parseGrantSpec);
  const fmtMachine = (m: MachineView, owner: string) =>
    `${m.id}\t${m.name}\towner=${owner}\t${m.killed ? 'KILLED' : m.online ? 'online' : 'offline'}\tfolders: ${m.policy.folders.join(', ') || '-'}\trunning=${m.running} queued=${m.queued}`;
  const fmtGrants = (g: readonly Grant[]) => g.map((x) => `${x.channel}:${x.read ? 'r' : ''}${x.send ? 'w' : ''}`).join(' ');

  const config = loadConfig();
  if (config.db !== ':memory:') mkdirSync(dirname(config.db), { recursive: true });
  const relay = createRelay({ db: openDb(config.db), channels: new Map() });
  const audit = (action: string, target: string, detail?: string) =>
    relay.audit.write({ actor: 'cli', action, target, ok: true, ...(detail ? { detail } : {}) });

  const [noun, verb, name, arg] = positional;
  try {
    if (noun === 'owner' && verb === 'add' && name) {
      const o = relay.tokens.addOwner({
        id: name,
        name: flag('name') ?? name,
        ...(flag('telegram') ? { telegramUser: flag('telegram')! } : {}),
        ...(flag('tz') ? { tz: flag('tz')! } : {}),
      });
      audit('owner.add', o.id);
      console.log(`owner ${o.id} (${o.name}) telegram=${o.telegramUser ?? '-'} tz=${o.tz}`);
    } else if (noun === 'owner' && verb === 'list') {
      for (const o of relay.tokens.owners()) console.log(`${o.id}\t${o.name}\ttelegram=${o.telegramUser ?? '-'}\ttz=${o.tz}`);
    } else if (noun === 'owner' && verb === 'console' && name) {
      const id = name.trim().toLowerCase();
      const readOnly = flag('read-only') === 'true';
      const { token, info } = relay.tokens.create({
        label: flag('label') ?? `${id}-console`,
        owner: id,
        grants: [{ channel: `owner:${id}`, read: true, send: !readOnly }],
      });
      audit('token.create', info.label, fmtGrants(info.grants));
      console.log(`console token ${info.label} (owner ${info.owner}) grants: ${fmtGrants(info.grants)}`);
      console.log('Sign in to the console with the username and this token.');
      console.log('Shown once. Store it in your password manager now:');
      console.log(token);
    } else if (noun === 'room' && verb === 'add' && name) {
      const team = flag('team');
      relay.rooms.addRoom(name, flag('title') ?? '', team);
      audit('room.add', name, team ? `team=${team}` : undefined);
      if (team) audit('room.team', name, team);
      console.log(`room ${name}${team ? ` (team ${team})` : ''}`);
    } else if (noun === 'room' && verb === 'team' && name && arg) {
      const team = arg === 'none' ? null : arg;
      relay.rooms.setRoomTeam(name, team);
      audit('room.team', name, team ?? 'none');
      console.log(`room ${name} team ${team ?? 'none'}`);
    } else if (noun === 'room' && verb === 'list') {
      for (const r of relay.rooms.allRooms()) {
        const members = relay.rooms.members(r.name);
        console.log(
          `${r.name}\t${r.title}\tteam: ${r.team ?? '-'}\tmembers: ${members.map((m) => `${m.label}(${m.owner})`).join(', ') || '-'}`,
        );
      }
    } else if (noun === 'team' && verb === 'add' && name) {
      const t = relay.teams.add({ id: name, name: flag('name') ?? name, ...(flag('gate') ? { gate: flag('gate') } : {}) });
      audit('team.add', t.id, `name=${t.name} gate=${t.gate}`);
      console.log(`team ${t.id} (${t.name}) gate=${t.gate}`);
    } else if (noun === 'team' && verb === 'list') {
      for (const t of relay.teams.list()) {
        const members = relay.teams.members(t.id).map((m) => `${m.owner}(${m.role})`);
        const invites = relay.teams.invites(t.id).map((i) => i.name);
        console.log(
          `${t.id}\t${t.name}\tgate=${t.gate}\tmembers: ${members.join(', ') || '-'}\tinvited: ${invites.join(', ') || '-'}\trooms: ${relay.rooms.roomsOfTeam(t.id).join(', ') || '-'}`,
        );
      }
    } else if (noun === 'team' && verb === 'rename' && name) {
      const n = flag('name');
      if (!n || n === 'true') usage();
      const t = relay.teams.rename(name, n);
      audit('team.rename', t.id, `name=${t.name}`);
      console.log(`team ${t.id} (${t.name})`);
    } else if (noun === 'team' && verb === 'member' && name && arg) {
      if (flag('remove') === 'true') {
        if (!relay.teams.removeMember(name, arg)) throw new Error(`${arg} is not a member of ${name}`);
        audit('team.member', name, `remove ${arg}`);
        console.log(`removed ${arg} from ${name}`);
      } else {
        const from = flag('from-invite');
        const m = from
          ? relay.teams.memberFromInvite(name, arg, from, flag('role') ?? 'member')
          : relay.teams.setMember(name, arg, flag('role') ?? 'member');
        audit('team.member', name, `add ${m.owner} ${m.role}${from ? ` from invite ${from}` : ''}`);
        console.log(`team ${name}: ${m.owner} ${m.role}`);
      }
    } else if (noun === 'team' && verb === 'gate' && name && arg) {
      const t = relay.teams.setGate(name, arg);
      audit('team.gate', t.id, t.gate);
      console.log(`team ${t.id} gate=${t.gate}`);
    } else if (noun === 'team' && verb === 'invite' && name) {
      const n = flag('name');
      if (!n || n === 'true') usage();
      const i = relay.teams.invite(name, n, flag('note') ?? null);
      audit('team.invite', name, `#${i.id} ${i.name}`);
      console.log(`team ${name}: invited ${i.name} (#${i.id})`);
    } else if (noun === 'team' && verb === 'uninvite' && name) {
      const n = flag('name');
      if (!n || n === 'true') usage();
      if (!relay.teams.uninvite(name, { name: n })) throw new Error(`no invite ${n} in ${name}`);
      audit('team.uninvite', name, n);
      console.log(`team ${name}: removed invite ${n}`);
    } else if (noun === 'token' && (verb === 'create' || verb === 'add') && name) {
      const owner = flag('owner');
      if (!owner) usage();
      const { token, info } = relay.tokens.create({ label: name, owner, grants: grantsOf() });
      audit('token.create', info.label, fmtGrants(info.grants));
      console.log(`token ${info.label} (owner ${info.owner}) grants: ${fmtGrants(info.grants) || '-'}`);
      console.log('Shown once. Store it in your password manager now:');
      console.log(token);
    } else if (noun === 'token' && verb === 'grants' && name) {
      const info = relay.tokens.setGrants(name, grantsOf());
      audit('token.grants', info.label, fmtGrants(info.grants));
      console.log(`token ${info.label} grants: ${fmtGrants(info.grants) || '-'}`);
    } else if (noun === 'token' && verb === 'list') {
      for (const t of relay.tokens.list(flag('all') === 'true')) {
        console.log(`${t.label}\t${t.owner}\t${fmtGrants(t.grants)}${t.revokedAt ? `\trevoked ${t.revokedAt}` : ''}`);
      }
    } else if (noun === 'token' && verb === 'revoke' && name) {
      if (!relay.tokens.revoke(name)) throw new Error(`no active token ${name}`);
      audit('token.revoke', name);
      console.log(`revoked ${name}`);
    } else if (noun === 'machine' && verb === 'add' && name) {
      const owner = flag('owner');
      if (!owner || owner === 'true') usage();
      const n = flag('name');
      const m = relay.tasks.addMachine({ id: name, owner, name: n && n !== 'true' ? n : name });
      audit('machine.add', m.id, `owner=${owner} name=${m.name}`);
      console.log(fmtMachine(m, owner));
      console.log('Policy is strict: no folders yet. Set one with `relay machine policy` or in the console.');
    } else if (noun === 'machine' && verb === 'list') {
      for (const m of relay.tasks.allMachines()) console.log(fmtMachine(m, relay.tasks.machine(m.id)!.owner));
    } else if (noun === 'machine' && verb === 'policy' && name) {
      const raw = flag('json');
      if (raw === undefined) {
        console.log(JSON.stringify(relay.tasks.policyOf(name.toLowerCase()), null, 2));
      } else {
        if (raw === 'true') usage();
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error('--json is not valid JSON');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--json must be an object');
        // Replace: the strict defaults plus exactly the fields given.
        const m = relay.tasks.updateMachine(null, name.toLowerCase(), { policy: { ...DEFAULT_POLICY, ...parsed } }, 'cli');
        audit('machine.policy', m.id, JSON.stringify(m.policy));
        console.log(JSON.stringify(m.policy, null, 2));
      }
    } else if (noun === 'machine' && verb === 'kill' && name && (arg === 'on' || arg === 'off')) {
      const m = relay.tasks.updateMachine(null, name.toLowerCase(), { killed: arg === 'on' }, 'cli');
      audit('machine.kill', m.id, arg);
      console.log(`machine ${m.id} killed=${m.killed}`);
    } else if (noun === 'audit') {
      for (const a of relay.audit.recent(Number(flag('limit') ?? 50))) {
        console.log(`${a.at}\t${a.actor}\t${a.action}\t${a.target ?? ''}\t${a.ok ? 'ok' : 'FAIL'}\t${a.detail ?? ''}`);
      }
    } else usage();
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    relay.db.close();
  }
}
