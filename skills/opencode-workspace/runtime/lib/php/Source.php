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
        return (is_array($v) && ($v['v'] ?? null) === 1) ? $v : null;
    }

    private static function writeCache(?string $f, array $v): void
    {
        if ($f === null) {
            return;
        }
        @mkdir(dirname($f), 0777, true);
        @file_put_contents($f, json_encode($v), LOCK_EX);
    }

    private static function summarize(string $id, array $session, array $messages, bool $isActive, string $projectDir): array
    {
        $time = (isset($session['time']) && self::isObj($session['time'])) ? $session['time'] : [];
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
            'agentType' => (isset($session['agent']) && is_string($session['agent']) && $session['agent'] !== '') ? $session['agent'] : 'build',
            'title' => (isset($session['title']) && is_string($session['title'])) ? $session['title'] : '',
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
                    if ($file !== null && !in_array($file, $s['files'], true)) {
                        $s['files'][] = $file;
                        if (count($s['files']) > self::FILES_KEEP) {
                            $s['files'] = array_slice($s['files'], count($s['files']) - self::FILES_KEEP);
                        }
                    }
                    if ($nm === 'subagent') {
                        $dg = [
                            'agent' => (isset($inp['agent']) && is_string($inp['agent'])) ? $inp['agent'] : '',
                            'description' => (isset($inp['description']) && is_string($inp['description'])) ? WUtil::safeLine($inp['description'], 140) : '',
                            'created' => (isset($pt['created']) && (is_int($pt['created']) || is_float($pt['created']))) ? $pt['created'] : 0,
                            'child' => null,
                        ];
                        if (isset($p['state']) && self::isObj($p['state']) && isset($p['state']['content']) && is_array($p['state']['content'])) {
                            foreach ($p['state']['content'] as $c) {
                                if (self::isObj($c) && isset($c['text']) && is_string($c['text'])
                                    && preg_match('/sessionID="(ses_[A-Za-z0-9]+)"/', $c['text'], $mm)) {
                                    $dg['child'] = $mm[1];
                                    break;
                                }
                            }
                        }
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
        foreach (is_array($projects) ? $projects : [] as $x) {
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
        $kids = array_values(array_filter($inWin, static fn($x) => !empty($x['parentID'])));
        usort($kids, static fn($a, $b) => self::num($b['time']['created'] ?? 0) <=> self::num($a['time']['created'] ?? 0));
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
            self::writeCache($cf, ['v' => 1, 'updated' => $upd, 'scopeOk' => true, 's' => $v['s'], 'delegations' => $v['delegations']]);
            $sums[$x['id']] = $v;
        }
        $delegByParent = [];
        foreach ($sums as $id => $v) {
            $delegByParent[$id] = $v['delegations'];
        }
        $exactDesc = [];
        foreach ($delegByParent as $dl) {
            foreach ($dl as $d) {
                if (!empty($d['child']) && ($d['description'] ?? '') !== '') {
                    $exactDesc[$d['child']] = $d['description'];
                }
            }
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
                $dl = $delegByParent[$x['parentID']] ?? [];
                $cands = array_values(array_filter($dl, static fn($d) => ($d['created'] ?? 0) <= self::num($x['time']['created'] ?? 0)));
                $same = array_values(array_filter($cands, static fn($d) => ($d['agent'] ?? '') === ($x['agent'] ?? '')));
                $pool = count($same) ? $same : $cands;
                usort($pool, static fn($a, $b) => ($b['created'] ?? 0) <=> ($a['created'] ?? 0));
                $pick = $pool[0] ?? null;
                if ($pick !== null && ($pick['description'] ?? '') !== '') {
                    $desc = $pick['description'];
                } elseif (($vs['title'] ?? '') !== '') {
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
