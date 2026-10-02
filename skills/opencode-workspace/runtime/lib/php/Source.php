<?php
declare(strict_types=1);

require_once __DIR__ . '/Util.php';
require_once __DIR__ . '/OClient.php';

final class WSource
{
    private const EVENTS_KEEP = 40;
    private const SEGS_KEEP = 20;
    private const FILES_KEEP = 12;
    private const SESS_CAP = 200;
    private const MSG_LIMIT = 200;

    // Cache schema version. Bumped to 2 when delegation records started carrying a child session
    // id: a `v: 1` cache holds records whose `child` is always null, and an inactive session is
    // never re-summarised, so those wrong records would otherwise persist for the whole window.
    private const CACHE_V = 2;

    // A rendered subagent tool text carries the child session id in one of two shapes: the quoted
    // `<subagent sessionID="ses_...">` completion envelope, and the unquoted
    // `... (sessionID: ses_...)` background notice. The structured `state.metadata.sessionID`
    // field is preferred, this regex is only the fallback for builds that do not send it.
    private const SES_IN_TEXT = '/sessionID(?:=|:\s*)(ses_[A-Za-z0-9]+)/';

    private static function num(mixed $v): int|float
    {
        return (is_int($v) || is_float($v)) && is_finite((float) $v) ? $v : 0;
    }

    private static function isObj(mixed $v): bool
    {
        return is_array($v) && ($v === [] || !array_is_list($v));
    }

    private static function values(mixed $v): array
    {
        return is_array($v) ? (array_is_list($v) ? $v : array_values($v)) : [];
    }

    private static function sumTokens(mixed $t): array
    {
        if (!self::isObj($t)) {
            return ['in' => 0, 'out' => 0, 'cache' => 0];
        }
        $c = (isset($t['cache']) && self::isObj($t['cache'])) ? $t['cache'] : [];
        return [
            'in' => (int) self::num($t['input'] ?? 0),
            'out' => (int) self::num($t['output'] ?? 0),
            'cache' => (int) self::num($c['read'] ?? 0) + (int) self::num($c['write'] ?? 0),
        ];
    }

    private static function cachePath(?string $storageDir, string $id): ?string
    {
        return ($storageDir !== null && $storageDir !== '') ? $storageDir . '/cache/oc-' . $id . '.json' : null;
    }

    private static function readCache(?string $f): ?array
    {
        if ($f === null) {
            return null;
        }
        $raw = @file_get_contents($f);
        if (!is_string($raw)) {
            return null;
        }
        $v = json_decode($raw, true);
        return (is_array($v) && ($v['v'] ?? null) === self::CACHE_V) ? $v : null;
    }

    private static function writeCache(?string $f, array $v): void
    {
        if ($f === null) {
            return;
        }
        // The per-session cache holds task text, tool inputs and relative paths, so it is kept
        // owner-only: 0700 for a directory this call creates, 0600 for the file. `mkdir` only
        // applies the mode to directories it creates itself, so an existing shared parent such as
        // `~/.cache` is never re-permissioned; the explicit chmod covers a file an older release
        // created with a looser mode. Both modes are POSIX-only and Windows largely ignores them.
        @mkdir(dirname($f), 0700, true);
        @file_put_contents($f, json_encode($v), LOCK_EX);
        @chmod($f, 0600);
    }

    // Child session id recorded by a subagent tool call, or null. The structured field wins; the
    // rendered text is only consulted when it is absent, and the summarizing session's own id is
    // never accepted, because a subagent report may quote the parent's session id back.
    private static function childIdOf(mixed $state, string $selfId): ?string
    {
        if (!self::isObj($state)) {
            return null;
        }
        if (self::isObj($state['metadata'] ?? null) && isset($state['metadata']['sessionID'])
            && is_string($state['metadata']['sessionID']) && str_starts_with($state['metadata']['sessionID'], 'ses_')) {
            return $state['metadata']['sessionID'] === $selfId ? null : $state['metadata']['sessionID'];
        }
        if (isset($state['content']) && is_array($state['content'])) {
            foreach ($state['content'] as $c) {
                if (self::isObj($c) && isset($c['text']) && is_string($c['text'])
                    && preg_match(self::SES_IN_TEXT, $c['text'], $mm)) {
                    return $mm[1] === $selfId ? null : $mm[1];
                }
            }
        }
        return null;
    }

    private static function summarize(string $id, array $session, array $messages, bool $isActive, string $projectDir): array
    {
        $time = (isset($session['time']) && self::isObj($session['time'])) ? $session['time'] : [];
        // `agent` and `title` are LLM-written summaries of the user's own prompt, which makes them
        // the most likely place for a pasted credential, so both are redacted on the way into the
        // summary. `agentType` falls back to 'build' exactly as before when it is missing or
        // empties out.
        $rawAgent = (isset($session['agent']) && is_string($session['agent']) && $session['agent'] !== '') ? $session['agent'] : 'build';
        $agentType = WUtil::redact($rawAgent);
        $s = [
            'started' => WUtil::isoMs((int) self::num($time['created'] ?? 0)),
            'updated' => WUtil::isoMs((int) self::num($time['updated'] ?? 0)),
            'tools' => 0,
            'tokens' => self::sumTokens($session['tokens'] ?? null),
            'events' => [],
            'lastKind' => null,
            'limit' => null,
            'files' => [],
            'todos' => null,
            'todosAt' => null,
            'todoSource' => null,
            'segs' => [],
            'stops' => [],
            'agentType' => $agentType !== '' ? $agentType : 'build',
            'title' => (isset($session['title']) && is_string($session['title'])) ? WUtil::redact($session['title']) : '',
        ];
        $delegations = [];
        $push = static function (string $t, string $kind, string $text, mixed $tool) use (&$s): void {
            if ($t === '' || $text === '') {
                return;
            }
            $s['events'][] = ['t' => $t, 'kind' => $kind, 'text' => $text, 'tool' => $tool];
            if (count($s['events']) > self::EVENTS_KEEP) {
                $s['events'] = array_slice($s['events'], count($s['events']) - self::EVENTS_KEEP);
            }
        };
        $hasTool = false;
        $hasText = false;
        $finish = null;
        foreach ($messages as $m) {
            if (!self::isObj($m)) {
                continue;
            }
            if (($m['type'] ?? null) === 'user') {
                $mt = (isset($m['time']) && self::isObj($m['time'])) ? $m['time'] : [];
                $t = isset($mt['created']) && (is_int($mt['created']) || is_float($mt['created'])) ? WUtil::isoMs((int) $mt['created']) : '';
                if (isset($m['text']) && is_string($m['text']) && trim($m['text']) !== '') {
                    $push($t, 'user', 'User instruction', null);
                    $s['lastKind'] = 'user';
                }
                continue;
            }
            // A finished subagent is recorded as a `synthetic` message carrying
            // `metadata.source = 'subagent'`, `metadata.childID` and a top-level `description`.
            // These are collected as delegation records too, because the 200-message window keeps
            // the LATEST messages: a long running subagent pushes its originating tool part out
            // of the window while the completion record stays. Field names and the description are
            // normalised to match the tool-part record exactly, so the two sources are
            // interchangeable.
            if (($m['type'] ?? null) === 'synthetic') {
                $md = isset($m['metadata']) && self::isObj($m['metadata']) ? $m['metadata'] : null;
                if ($md !== null && ($md['source'] ?? null) === 'subagent'
                    && isset($md['childID']) && is_string($md['childID']) && str_starts_with($md['childID'], 'ses_')) {
                    $delegations[] = [
                        'agent' => (isset($md['agent']) && is_string($md['agent'])) ? $md['agent'] : '',
                        'description' => (isset($m['description']) && is_string($m['description'])) ? WUtil::safeLine($m['description'], 140) : '',
                        'created' => (isset($m['time']) && self::isObj($m['time']) && isset($m['time']['created']) && (is_int($m['time']['created']) || is_float($m['time']['created']))) ? $m['time']['created'] : 0,
                        'child' => $md['childID'] === $id ? null : $md['childID'],
                    ];
                }
                continue;
            }
            if (($m['type'] ?? null) !== 'assistant') {
                continue;
            }
            if (isset($m['finish']) && is_string($m['finish'])) {
                $finish = $m['finish'];
            }
            if (array_key_exists('error', $m) && $m['error'] !== null) {
                $es = json_encode($m['error']);
                if (!is_string($es)) {
                    $es = '';
                }
                if (preg_match('/(usage limit|rate limit|limit reached|resets? (at|in))/i', $es) && mb_strlen($es) < 400) {
                    $s['limit'] = WUtil::clip(WUtil::redact($es), 200);
                }
            }
            $mt = (isset($m['time']) && self::isObj($m['time'])) ? $m['time'] : [];
            $mt0 = isset($mt['created']) && (is_int($mt['created']) || is_float($mt['created'])) ? WUtil::isoMs((int) $mt['created']) : '';
            foreach (self::values($m['content'] ?? null) as $p) {
                if (!self::isObj($p)) {
                    continue;
                }
                if (($p['type'] ?? null) === 'text') {
                    if (!isset($p['text']) || !is_string($p['text']) || trim($p['text']) === '') {
                        continue;
                    }
                    $hasText = true;
                    if (preg_match('/(usage limit|rate limit|limit reached|resets? (at|in))/i', $p['text']) && mb_strlen($p['text']) < 400) {
                        $s['limit'] = WUtil::clip(WUtil::redact($p['text']), 200);
                    }
                    $push($mt0, 'text', WUtil::safeLine($p['text'], 180), null);
                    $s['lastKind'] = 'text';
                } elseif (($p['type'] ?? null) === 'tool') {
                    $hasTool = true;
                    $s['tools'] += 1;
                    $inp = (isset($p['state']) && self::isObj($p['state']) && isset($p['state']['input']) && self::isObj($p['state']['input']))
                        ? $p['state']['input'] : [];
                    $pt = (isset($p['time']) && self::isObj($p['time'])) ? $p['time'] : [];
                    $t = isset($pt['created']) && (is_int($pt['created']) || is_float($pt['created'])) ? WUtil::isoMs((int) $pt['created']) : '';
                    $nm = isset($p['name']) && is_string($p['name']) ? $p['name'] : '';
                    [$text, $file] = WUtil::describeTool($nm, $inp, $projectDir);
                    // `describeTool` already redacts the path; redaction here is idempotent and
                    // keeps the invariant local: nothing reaches `s.files` without passing through
                    // `WUtil::redact`.
                    if ($file !== null && !in_array($file, $s['files'], true)) {
                        $s['files'][] = WUtil::redact($file);
                        if (count($s['files']) > self::FILES_KEEP) {
                            $s['files'] = array_slice($s['files'], count($s['files']) - self::FILES_KEEP);
                        }
                    }
                    if ($nm === 'subagent') {
                        $dg = [
                            'agent' => (isset($inp['agent']) && is_string($inp['agent'])) ? $inp['agent'] : '',
                            'description' => (isset($inp['description']) && is_string($inp['description'])) ? WUtil::safeLine($inp['description'], 140) : '',
                            'created' => (isset($pt['created']) && (is_int($pt['created']) || is_float($pt['created']))) ? $pt['created'] : 0,
                            'child' => self::childIdOf($p['state'] ?? null, $id),
                        ];
                        $delegations[] = $dg;
                    }
                    $push($t, 'tool', $text, $nm);
                    $s['lastKind'] = 'tool';
                }
            }
        }
        if ($hasTool) {
            $s['limit'] = null;
            $s['lastKind'] = 'tool';
        } elseif ($hasText) {
            $s['lastKind'] = ($finish === 'stop' || (!$isActive && $finish !== 'tool-calls')) ? 'final' : 'text';
        } elseif ($s['lastKind'] === null) {
            $s['lastKind'] = 'thinking';
        }
        if ($isActive && $s['lastKind'] === 'final') {
            $s['lastKind'] = 'text';
        }
        $maxEv = WUtil::tsMs($s['updated']);
        foreach ($s['events'] as $e) {
            $ms = WUtil::tsMs($e['t']);
            if ($ms !== null && ($maxEv === null || $ms > $maxEv)) {
                $maxEv = $ms;
            }
        }
        if ($maxEv !== null) {
            $s['updated'] = WUtil::isoMs($maxEv);
        }
        $outcome = $isActive ? null : ($session['outcome'] ?? null);
        if ($outcome === 'succeeded' || $outcome === 'failed' || $outcome === 'interrupted') {
            $s['lastKind'] = 'handback';
        }
        if ($outcome === 'failed' || $outcome === 'interrupted') {
            $s['stops'][] = [$id, $s['updated']];
        }
        $times = [];
        foreach ($s['events'] as $e) {
            $ms = WUtil::tsMs($e['t']);
            if ($ms !== null) {
                $times[$ms] = true;
            }
        }
        $times = array_keys($times);
        sort($times, SORT_NUMERIC);
        $s['_times'] = $times;
        return ['s' => $s, 'delegations' => $delegations];
    }

    private static function buildSegs(array &$s, int $cooldownMs): void
    {
        $times = $s['_times'] ?? [];
        unset($s['_times']);
        $segs = [];
        $start = null;
        $last = null;
        $flush = static function (bool $open) use (&$segs, &$start, &$last): void {
            if ($start === null) {
                return;
            }
            $segs[] = [WUtil::isoMs($start), $open ? null : WUtil::isoMs($last)];
            if (count($segs) > self::SEGS_KEEP) {
                $segs = array_slice($segs, count($segs) - self::SEGS_KEEP);
            }
        };
        foreach ($times as $ms) {
            if ($start === null) {
                $start = $ms;
                $last = $ms;
            } elseif ($ms - $last <= $cooldownMs) {
                $last = $ms;
            } else {
                $flush(false);
                $start = $ms;
                $last = $ms;
            }
        }
        $flush(true);
        if ($segs === []) {
            $segs[] = [$s['started'], null];
        }
        $s['segs'] = $segs;
    }

    public static function scan(string $projectDir, ?string $storageDir, array $cfg, int $nowSec): array
    {
        $empty = ['exists' => false, 'mains' => [], 'runs' => []];
        $svc = WOClient::getService($projectDir, $storageDir);
        if ($svc === null) {
            return $empty;
        }
        try {
            $projects = WOClient::apiGet($svc, '/api/project');
        } catch (Throwable) {
            $svc = WOClient::getService($projectDir, $storageDir);
            if ($svc === null) {
                return $empty;
            }
            try {
                $projects = WOClient::apiGet($svc, '/api/project');
            } catch (Throwable) {
                return $empty;
            }
        }
        $want = WOClient::normDir($projectDir);
        // the service can hold several project rows with the same canonical path (re-init, re-clone,
        // moved checkout), and none of them is authoritative: `time.active` gets touched on any row,
        // so ranking by it picks the wrong one and silently hides every session of the newest row.
        // union the sessions of all matching rows instead, deduped by session id.
        $matches = [];
        // /api/project returns a bare array today; accept a {data:…} envelope too so a future
        // change of shape shows up as an empty dashboard rather than a silent one.
        $rows = is_array($projects) ? $projects : (self::isObj($projects) ? array_values($projects) : []);
        foreach ($rows as $x) {
            if (self::isObj($x) && WOClient::normDir((string) ($x['canonical'] ?? '')) === $want) {
                $matches[] = $x;
            }
        }
        if ($matches === []) {
            return $empty;
        }
        $parts = [];
        try {
            foreach ($matches as $row) {
                if (!isset($row['id'])) {
                    continue;
                }
                $parts[] = WOClient::apiGet($svc, '/api/session?project=' . rawurlencode((string) $row['id']) . '&limit=' . self::SESS_CAP . '&order=desc');
            }
            $active = WOClient::apiGet($svc, '/api/session/active');
        } catch (Throwable) {
            WOClient::resetService();
            return $empty;
        }
        $merged = [];
        foreach ($parts as $p) {
            if (!self::isObj($p) || !isset($p['data']) || !is_array($p['data'])) {
                continue;
            }
            foreach ($p['data'] as $x) {
                if (self::isObj($x) && isset($x['id']) && is_string($x['id']) && $x['id'] !== '') {
                    $merged[$x['id']] = $x;
                }
            }
        }
        $sessions = array_values($merged);
        $running = [];
        if (self::isObj($active) && isset($active['data']) && self::isObj($active['data'])) {
            foreach ($active['data'] as $k => $_) {
                $running[$k] = true;
            }
        }
        $cutoff = ($nowSec - (int) $cfg['window_days'] * 86400) * 1000;
        $inWin = array_values(array_filter($sessions, static fn($x) => self::num($x['time']['created'] ?? 0) >= $cutoff));
        $byId = [];
        foreach ($inWin as $x) {
            if (isset($x['id'])) {
                $byId[$x['id']] = $x;
            }
        }
        $roots = array_values(array_filter($inWin, static fn($x) => empty($x['parentID'])));
        usort($roots, static fn($a, $b) => self::num($b['time']['updated'] ?? 0) <=> self::num($a['time']['updated'] ?? 0));
        $roots = array_slice($roots, 0, (int) $cfg['mains_max']);
        // `usort` is not stable in PHP while `Array.prototype.sort` is in JS, so equal creation times are
        // broken on the original position here too. The delegation fallback below walks `$kids` in
        // order, so an unstable sort would let the two runtimes hand two children different
        // delegations.
        $kidsDec = [];
        foreach ($inWin as $i => $x) {
            if (!empty($x['parentID'])) {
                $kidsDec[] = [$i, $x];
            }
        }
        usort($kidsDec, static function ($a, $b): int {
            $c = self::num($b[1]['time']['created'] ?? 0) <=> self::num($a[1]['time']['created'] ?? 0);
            return $c !== 0 ? $c : ($a[0] <=> $b[0]);
        });
        $kids = array_map(static fn($e) => $e[1], $kidsDec);
        $kids = array_slice($kids, 0, self::SESS_CAP);
        $scope = [...$roots, ...$kids];
        $scopeIds = [];
        foreach ($scope as $x) {
            $scopeIds[$x['id']] = true;
        }
        $rootOf = static function (array $x) use ($byId): string {
            $cur = $x;
            $seen = [];
            while (isset($cur['parentID']) && is_string($cur['parentID']) && isset($byId[$cur['parentID']]) && !isset($seen[$cur['id']])) {
                $seen[$cur['id']] = true;
                $cur = $byId[$cur['parentID']];
            }
            return (isset($cur['id']) && is_string($cur['id'])) ? $cur['id'] : (string) $x['id'];
        };
        $sums = [];
        foreach ($scope as $x) {
            $cf = self::cachePath($storageDir, (string) $x['id']);
            $upd = self::num($x['time']['updated'] ?? 0);
            $cached = self::readCache($cf);
            if ($cached !== null && ($cached['updated'] ?? null) == $upd && !isset($running[$x['id']]) && !empty($cached['scopeOk'])) {
                $sums[$x['id']] = ['s' => $cached['s'], 'delegations' => $cached['delegations'] ?? []];
                continue;
            }
            $messages = [];
            try {
                $r = WOClient::apiGet($svc, '/api/session/' . rawurlencode((string) $x['id']) . '/message?order=desc&limit=' . self::MSG_LIMIT);
                if (self::isObj($r) && isset($r['data']) && is_array($r['data'])) {
                    $messages = array_values(array_filter($r['data'], self::isObj(...)));
                    $messages = array_reverse($messages);
                }
            } catch (Throwable) {
                if ($cached !== null) {
                    $sums[$x['id']] = ['s' => $cached['s'], 'delegations' => $cached['delegations'] ?? []];
                    continue;
                }
                $messages = [];
            }
            $v = self::summarize((string) $x['id'], $x, $messages, isset($running[$x['id']]), $projectDir);
            self::buildSegs($v['s'], (int) $cfg['cooldown'] * 1000);
            self::writeCache($cf, ['v' => self::CACHE_V, 'updated' => $upd, 'scopeOk' => true, 's' => $v['s'], 'delegations' => $v['delegations']]);
            $sums[$x['id']] = $v;
        }
        $delegByParent = [];
        foreach ($sums as $id => $v) {
            $delegByParent[$id] = $v['delegations'];
        }
        // Exact child-id -> description map, plus the set of delegation records already claimed by
        // an exact match. The claim set is what keeps the mapping 1:1: without it, several children
        // whose session id is not recoverable all fell through to the positional heuristic below
        // and were handed the SAME most recent delegation, which is why every running subagent
        // rendered with the same title. A record claimed here is also removed from the positional
        // pool below.
        $exactDesc = [];
        $claimedDel = [];
        foreach ($delegByParent as $pid => $dl) {
            $used = [];
            foreach ($dl as $i => $d) {
                if (!empty($d['child']) && ($d['description'] ?? '') !== '') {
                    $exactDesc[$d['child']] = $d['description'];
                    $used[$i] = true;
                }
            }
            $claimedDel[$pid] = $used;
        }
        $mains = [];
        foreach ($roots as $x) {
            if (!isset($sums[$x['id']])) {
                continue;
            }
            $m = $sums[$x['id']]['s'];
            $m['session'] = $x['id'];
            $mains[] = $m;
        }
        $runs = [];
        foreach ($kids as $x) {
            if (!isset($sums[$x['id']])) {
                continue;
            }
            $vs = $sums[$x['id']]['s'];
            $desc = '';
            if (isset($exactDesc[$x['id']])) {
                $desc = $exactDesc[$x['id']];
            } else {
                // Positional fallback for a child whose id was not recoverable. Still 1:1: `$kids`
                // is walked in creation order and each delegation record is consumed at most once
                // per parent, so no two children can end up with the same description. Ties break
                // on the record's index in `delegations`, which is message order and therefore
                // identical in both runtimes.
                $dl = $delegByParent[$x['parentID']] ?? [];
                if (!isset($claimedDel[$x['parentID']])) {
                    $claimedDel[$x['parentID']] = [];
                }
                $used = $claimedDel[$x['parentID']];
                $cands = [];
                foreach ($dl as $i => $d) {
                    if (!isset($used[$i]) && self::num($d['created'] ?? 0) <= self::num($x['time']['created'] ?? 0)) {
                        $cands[] = $i;
                    }
                }
                $same = array_values(array_filter($cands, static fn($i) => ($dl[$i]['agent'] ?? '') === ($x['agent'] ?? '')));
                $pool = count($same) ? $same : $cands;
                usort($pool, static function ($a, $b) use ($dl): int {
                    $c = self::num($dl[$b]['created'] ?? 0) <=> self::num($dl[$a]['created'] ?? 0);
                    return $c !== 0 ? $c : ($a <=> $b);
                });
                $pick = $pool[0] ?? null;
                if ($pick !== null) {
                    $claimedDel[$x['parentID']][$pick] = true;
                    if (($dl[$pick]['description'] ?? '') !== '') {
                        $desc = $dl[$pick]['description'];
                    }
                }
                if ($desc === '' && ($vs['title'] ?? '') !== '') {
                    $desc = WUtil::safeLine(WUtil::oneLine((string) ($x['title'] ?? ''), 140), 140);
                }
            }
            $pid = $x['parentID'] ?? null;
            $vs['id'] = $x['id'];
            $vs['session'] = $rootOf($x);
            $vs['description'] = $desc;
            $vs['parentAgent'] = ($pid && isset($scopeIds[$pid]) && !empty($byId[$pid]['parentID'])) ? $pid : ($pid ?: null);
            $vs['inactive'] = !isset($running[$x['id']]);
            $runs[] = $vs;
        }
        $relAll = static function (array $list) use ($projectDir): array {
            $out = [];
            $p = WOClient::normDir($projectDir);
            $p = ltrim($p, '/');
            foreach ($list as $f) {
                $n = ltrim(WOClient::normDir((string) $f), '/');
                if (str_starts_with($n, $p . '/')) {
                    $out[] = str_replace('\\', '/', substr((string) $f, strlen($projectDir) + 1));
                } else {
                    $parts = preg_split('~[/\\\\]~', (string) $f) ?: [];
                    $b = end($parts);
                    $out[] = ($b === false || $b === '') ? (string) $f : $b;
                }
            }
            $out = array_values(array_filter($out, static fn($f) => $f !== ''));
            $out = array_values(array_unique($out));
            return array_slice($out, -self::FILES_KEEP);
        };
        foreach ($mains as &$m) {
            $m['files'] = $relAll($m['files']);
        }
        unset($m);
        foreach ($runs as &$m) {
            $m['files'] = $relAll($m['files']);
        }
        unset($m);
        return ['exists' => true, 'mains' => $mains, 'runs' => $runs];
    }
}
