<?php
declare(strict_types=1);

require_once __DIR__ . '/Util.php';
require_once __DIR__ . '/Source.php';

final class WOffice
{
    public const VERSION = '1.0.0';

    public static function build(string $projectDir, ?string $storageDir, array $cfg, int $now): array
    {
        $nowSec = intdiv($now, 1000);
        $scan = WSource::scan($projectDir, $storageDir, $cfg, $nowSec);
        $RW = (int) $cfg['running_window'] * 1000;
        $CD = (int) $cfg['cooldown'] * 1000;
        $MA = (int) $cfg['main_active'] * 1000;

        $stops = [];
        foreach ([...$scan['mains'], ...$scan['runs']] as $src) {
            foreach ($src['stops'] as [$id, $t]) {
                $stops[$id][] = WUtil::tsMs($t);
            }
        }

        $runs = $scan['runs'];
        usort($runs, static fn($a, $b) => (WUtil::tsMs($a['started']) <=> WUtil::tsMs($b['started'])) ?: strcmp($a['id'], $b['id']));
        $byId = [];
        foreach ($runs as $ri => &$r) {
            $segs = [];
            foreach ($r['segs'] as [$a, $b]) {
                $segs[] = ['start' => WUtil::tsMs($a), 'startIso' => $a, 'end' => $b === null ? null : WUtil::tsMs($b), 'endIso' => $b];
            }
            $status = $r['limit'] ? 'limit' : 'done';
            $reason = null;
            $li = count($segs) - 1;
            if ($segs[$li]['end'] === null) {
                $st = array_values(array_filter($stops[$r['id']] ?? [], static fn($ms) => $ms >= $segs[$li]['start']));
                $upd = WUtil::tsMs($r['updated']);
                if ($st) {
                    $segs[$li]['end'] = min($st);
                    $status = 'stopped';
                    $reason = 'userStopped';
                } elseif ($r['lastKind'] === 'handback' || $r['limit']) {
                    $segs[$li]['end'] = $upd;
                    $status = $r['limit'] ? 'limit' : 'done';
                } elseif (!empty($r['inactive'])) {
                    $segs[$li]['end'] = $upd;
                    $status = $r['limit'] ? 'limit' : 'done';
                } elseif ($now - $upd <= $RW) {
                    $status = 'working';
                } else {
                    $segs[$li]['end'] = $upd + $RW;
                    $status = 'stopped';
                    $reason = 'no-activity';
                }
                if ($segs[$li]['end'] !== null) {
                    $segs[$li]['endIso'] = WUtil::isoMs($segs[$li]['end']);
                }
            }
            $r['effSegs'] = $segs;
            $r['status'] = $status;
            $r['reason'] = $reason;
            $byId[$r['id']] = $ri;
        }
        unset($r);

        $jobs = [];
        foreach ($runs as $ri => $r) {
            foreach ($r['effSegs'] as $k => $sg) {
                $jobs[] = $sg + ['ri' => $ri, 'rid' => $r['id'], 'k' => $k, 'who' => null];
            }
        }
        usort($jobs, static fn($a, $b) => ($a['start'] <=> $b['start']) ?: (strcmp($a['rid'], $b['rid']) ?: ($a['k'] <=> $b['k'])));
        $team = $cfg['team'];
        $pool = array_fill(0, count($team), null); 
        $fl = []; 
        $charOf = [];
        $free = static function (?int $ji, int $start) use (&$jobs, $CD): bool {
            return $ji === null || ($jobs[$ji]['end'] !== null && $jobs[$ji]['end'] + $CD <= $start);
        };
        foreach ($jobs as $jx => $job) {
            $prev = $charOf[$job['rid']] ?? null;
            $pick = null;
            if ($job['k'] > 0 && $prev !== null) {
                $sj = $prev['kind'] === 'pool' ? $pool[$prev['idx']] : $fl[$prev['idx']]['job'];
                if (($sj !== null && $jobs[$sj]['rid'] === $job['rid']) || $free($sj, $job['start'])) {
                    $pick = $prev;
                }
            }
            if ($pick === null) {
                foreach ($pool as $i => $sj) {
                    if ($free($sj, $job['start'])) {
                        $pick = ['kind' => 'pool', 'idx' => $i, 'name' => $team[$i]];
                        break;
                    }
                }
            }
            if ($pick === null) {
                $j = -1;
                foreach ($fl as $i => $slot) {
                    if ($free($slot['job'], $job['start'])) {
                        $j = $i;
                        break;
                    }
                }
                if ($j < 0) {
                    $j = count($fl);
                    $fl[] = ['job' => null, 'name' => null];
                }
                if ($prev !== null && $prev['kind'] === 'fl') {
                    $name = $prev['name'];
                } else {
                    $used = [];
                    foreach ($fl as $slot) {
                        if (!$free($slot['job'], $job['start'])) {
                            $used[$slot['name']] = true;
                        }
                    }
                    $L = count($cfg['freelancers']);
                    $base = WUtil::hash($job['rid']) % $L;
                    $name = null;
                    for ($n = 0; $n < $L; $n++) {
                        $cand = $cfg['freelancers'][($base + $n) % $L];
                        if (!isset($used[$cand])) {
                            $name = $cand;
                            break;
                        }
                    }
                    $name ??= $cfg['freelancers'][$base] . ' ' . ($j + 1);
                }
                $pick = ['kind' => 'fl', 'idx' => $j, 'name' => $name];
            }
            if ($pick['kind'] === 'pool') {
                $pool[$pick['idx']] = $jx;
            } else {
                $fl[$pick['idx']] = ['job' => $jx, 'name' => $pick['name']];
            }
            $jobs[$jx]['who'] = $pick;
            $charOf[$job['rid']] = $pick;
        }

        $flPal = $cfg['colors']['freelancers'];
        $teamCol = $cfg['colors']['team'];
        $charInfo = static function (array $who, ?array $run) use ($team, $flPal, $teamCol): array {
            if ($who['kind'] === 'pool') {
                return ['key' => 'tim-' . $who['idx'], 'name' => $team[$who['idx']], 'label' => $team[$who['idx']], 'color' => $teamCol[$who['idx'] % count($teamCol)]];
            }
            return ['key' => 'fl-' . $run['id'], 'name' => $who['name'], 'label' => 'Freelancer · ' . $who['name'],
                'color' => $flPal[WUtil::hash($who['name']) % count($flPal)]];
        };
        $jobState = static fn(array $job): string => $job['end'] === null ? 'working' : ($now - $job['end'] < $CD ? 'done' : 'idle');
        $task = static fn(array $r): string => $r['description'] !== '' ? $r['description'] : $r['agentType'];
        $depthCache = [];
        $depthOf = static function (array $r) use (&$runs, &$byId, &$depthCache): int {
            if (isset($depthCache[$r['id']])) {
                return $depthCache[$r['id']];
            }
            $d = 1;
            $cur = $r;
            $seen = [$r['id'] => true];
            while ($cur['parentAgent'] !== null && isset($byId[$cur['parentAgent']]) && !isset($seen[$cur['parentAgent']]) && $d < 50) {
                $seen[$cur['parentAgent']] = true;
                $cur = $runs[$byId[$cur['parentAgent']]];
                $d += 1;
            }
            return $depthCache[$r['id']] = $d;
        };
        $parentOf = static function (array $r) use (&$runs, &$byId, &$charOf, $charInfo, $cfg): array {
            $pid = $r['parentAgent'];
            if ($pid !== null && isset($byId[$pid])) {
                $p = $runs[$byId[$pid]];
                $who = $charInfo($charOf[$p['id']], $p);
                return ['key' => $who['key'], 'label' => $who['label']];
            }
            return ['key' => 'lead', 'label' => $cfg['lead']];
        };
        $runOut = static function (array $job) use (&$runs, $task, $now, $parentOf, $depthOf): array {
            $r = $runs[$job['ri']];
            $lastJob = count($r['effSegs']) - 1 === $job['k'];
            $par = $parentOf($r);
            return [
                'id' => $r['id'],
                'agent_type' => $r['agentType'],
                'task' => $task($r),
                'stitle' => ($r['title'] ?? '') !== '' ? $r['title'] : null,
                'status' => $lastJob ? $r['status'] : 'done',
                'reason' => $lastJob ? $r['reason'] : null,
                'segment' => $job['k'] + 1,
                'started' => $job['startIso'],
                'ended' => $job['end'] === null ? null : $job['endIso'],
                'updated' => $r['updated'],
                'last' => array_slice(array_reverse($r['events']), 0, 8),
                'files' => array_slice($r['files'], -6),
                'tools' => $r['tools'],
                'tokens' => $r['tokens'],
                'elapsedMs' => ($job['end'] === null ? $now : $job['end']) - $job['start'],
                'parent' => $par['label'],
                'parent_key' => $par['key'],
                'depth' => $depthOf($r),
            ];
        };

        $teamOut = [];
        foreach ($pool as $i => $ji) {
            $teamOut[] = $charInfo(['kind' => 'pool', 'idx' => $i], null) + [
                'kind' => 'team', 'slot' => $i, 'desk' => $i,
                'state' => $ji !== null ? $jobState($jobs[$ji]) : 'idle',
                'run' => $ji !== null ? $runOut($jobs[$ji]) : null,
            ];
        }
        $freelancers = [];
        foreach ($fl as $j => $slot) {
            if ($slot['job'] === null) {
                continue;
            }
            $job = $jobs[$slot['job']];
            $st = $jobState($job);
            if ($st === 'idle') {
                continue;
            }
            $freelancers[] = $charInfo(['kind' => 'fl', 'idx' => $j, 'name' => $slot['name']], $runs[$job['ri']]) + [
                'kind' => 'freelancer', 'slot' => $j, 'desk' => $j < (int) $cfg['spare_desks'] ? $j : null, 'state' => $st, 'run' => $runOut($job),
            ];
        }

        $kids = [];
        foreach ($runs as $r) {
            if ($r['status'] === 'working') {
                $kids[$r['session']] = ($kids[$r['session']] ?? 0) + 1;
            }
        }
        $mains = array_values(array_filter($scan['mains'], static fn($m) => $m['updated'] !== null));
        usort($mains, static fn($a, $b) => (WUtil::tsMs($b['updated']) <=> WUtil::tsMs($a['updated'])) ?: strcmp($a['session'], $b['session']));
        $states = array_map(static function ($m) use ($now, $MA, $RW, $CD, $kids): array {
            $age = $now - WUtil::tsMs($m['updated']);
            $k = $kids[$m['session']] ?? 0;
            if ($m['lastKind'] !== 'final' && $age <= $MA) {
                return ['working', 'active'];
            }
            if ($m['lastKind'] === 'tool' && $age <= $RW) {
                return ['working', 'tool'];
            }
            if ($k > 0) {
                return ['working', 'waiting-team'];
            }
            if ($m['lastKind'] === 'final' && $age < $CD) {
                return ['done', null];
            }
            return ['idle', null];
        }, $mains);
        $di = -1;
        foreach ($states as $i => $s) {
            if ($s[0] === 'working') {
                $di = $i;
                break;
            }
        }
        if ($di < 0) {
            $di = $mains ? 0 : -1;
        }
        $dm = $di >= 0 ? $mains[$di] : null;
        $activeMains = count(array_filter($states, static fn($s) => $s[0] === 'working'));
        $leadColor = $cfg['colors']['lead'];
        $lead = [
            'key' => 'lead', 'name' => $cfg['lead'], 'label' => $cfg['lead'], 'role' => 'Lead', 'kind' => 'lead', 'color' => $leadColor,
            'state' => $dm ? $states[$di][0] : 'idle',
            'activity' => $dm ? $states[$di][1] : null,
            'session' => $dm ? substr($dm['session'], 0, 8) : null,
            'stitle' => ($dm && ($dm['title'] ?? '') !== '' ? $dm['title'] : null),
            'updated' => $dm ? $dm['updated'] : null,
            'last' => $dm ? array_slice(array_values(array_filter(array_reverse($dm['events']), static fn($e) => $e['kind'] !== 'text' && $e['tool'] !== 'subagent')), 0, 8) : [],
            'tools' => $dm ? $dm['tools'] : 0,
            'tokens' => $dm ? $dm['tokens'] : 0,
            'waiting_on' => $dm ? ($kids[$dm['session']] ?? 0) : 0,
            'other_sessions' => max(0, $activeMains - ($dm && $states[$di][0] === 'working' ? 1 : 0)),
            'sessions' => count($mains),
            'todos' => $dm && $dm['todos'] !== null ? ['items' => $dm['todos'], 'at' => $dm['todosAt'], 'source' => $dm['todoSource']] : null,
        ];

        $K = ['key' => 'lead', 'name' => $cfg['lead'], 'label' => $cfg['lead'], 'color' => $leadColor];
        $feed = [];
        $add = static function (string $t, int $ms, array $who, string $kind, string $text, ?string $tool, array $extra = []) use (&$feed): void {
            $feed[] = ['ms' => $ms, 'i' => count($feed), 'e' => ['t' => $t, 'who' => $who['key'], 'name' => $who['label'], 'color' => $who['color'], 'kind' => $kind, 'text' => $text, 'tool' => $tool] + $extra];
        };
        foreach ($mains as $m) {
            foreach ($m['events'] as $e) {
                if ($e['kind'] === 'text' || $e['tool'] === 'subagent') {
                    continue;
                }
                $add($e['t'], WUtil::tsMs($e['t']), $K, $e['kind'], $e['text'], $e['tool']);
            }
        }
        $jobsOf = [];
        foreach ($jobs as $jx => $job) {
            $jobsOf[$job['rid']][] = $jx;
            $r = $runs[$job['ri']];
            $who = $charInfo($job['who'], $r);
            if ($job['k'] === 0) {
                $pi = $r['parentAgent'] !== null ? ($byId[$r['parentAgent']] ?? null) : null;
                $req = $pi !== null ? $charInfo($charOf[$runs[$pi]['id']], $runs[$pi]) : $K;
                $add($job['startIso'], $job['start'], $req, 'assign', $req['label'] . ' asked ' . $who['label'] . ': ' . $task($r), null);
            } else {
                $add($job['startIso'], $job['start'], $who, 'resume', $who['label'] . ' continued: ' . $task($r), null);
            }
            if ($job['end'] !== null && $job['end'] <= $now) {
                $lastJob = count($r['effSegs']) - 1 === $job['k'];
                $text = $who['label'] . ' done: ' . $task($r);
                if ($lastJob && $r['status'] === 'limit') {
                    $text = $who['label'] . ' paused — usage limit';
                } elseif ($lastJob && $r['reason'] === 'userStopped') {
                    $text = $who['label'] . ' stopped: ' . $task($r);
                } elseif ($lastJob && $r['reason'] === 'no-activity') {
                    $text = $who['label'] . ' stopped — no activity for ' . (int) round($cfg['running_window'] / 60) . ' min';
                }
                $add($job['endIso'], $job['end'], $who, 'done', $text, null, ['status' => $r['status'], 'reason' => $r['reason']]);
            }
        }
        foreach ($runs as $r) {
            $js = $jobsOf[$r['id']] ?? [];
            foreach ($r['events'] as $e) {
                $ms = WUtil::tsMs($e['t']);
                $jx = $js[0];
                foreach ($js as $j) {
                    if ($jobs[$j]['start'] <= $ms) {
                        $jx = $j;
                    }
                }
                $add($e['t'], $ms, $charInfo($jobs[$jx]['who'], $r), $e['kind'], $e['text'], $e['tool']);
            }
        }
        $byTime = static fn($a, $b) => ($b['ms'] <=> $a['ms']) ?: ($a['i'] <=> $b['i']);
        usort($feed, $byTime);
        $isLife = static fn($f) => in_array($f['e']['kind'], ['assign', 'resume', 'done'], true);
        $life = array_slice(array_values(array_filter($feed, $isLife)), 0, 60);
        $acts = array_slice(array_values(array_filter($feed, static fn($f) => !$isLife($f))), 0, 120);
        $feed = [...$life, ...$acts];
        usort($feed, $byTime);

        $hist = $runs;
        usort($hist, static fn($a, $b) => (WUtil::tsMs($b['started']) <=> WUtil::tsMs($a['started'])) ?: strcmp($a['id'], $b['id']));
        $histOut = [];
        foreach (array_slice($hist, 0, 40) as $r) {
            $js = $jobsOf[$r['id']];
            $job = $jobs[$js[count($js) - 1]];
            $who = $charInfo($job['who'], $r);
            $par = $parentOf($r);
            $histOut[] = [
                'id' => $r['id'], 'who' => $who['key'], 'name' => $who['name'], 'label' => $who['label'], 'color' => $who['color'],
                'kind' => $job['who']['kind'] === 'pool' ? 'team' : 'freelancer', 'agent_type' => $r['agentType'], 'task' => $task($r),
                'stitle' => ($r['title'] ?? '') !== '' ? $r['title'] : null, 'inactive' => !empty($r['inactive']), 'status' => $r['status'], 'reason' => $r['reason'],
                'started' => $r['started'], 'ended' => $job['end'] === null ? null : $job['endIso'],
                'elapsedMs' => ($job['end'] === null ? $now : $job['end']) - WUtil::tsMs($r['started']),
                'parent' => $par['label'], 'parent_key' => $par['key'], 'depth' => $depthOf($r), 'tools' => $r['tools'],
            ];
        }
        $recent = [];
        foreach ($runs as $r) {
            if ($now - WUtil::tsMs($r['started']) <= 48 * 3600 * 1000) {
                $recent[] = $r['started'];
            }
        }
        $tunnel = $storageDir !== null ? trim((string) @file_get_contents($storageDir . '/tunnel-url.txt')) : '';
        if (!preg_match('~^https://[A-Za-z0-9.-]+(:\d+)?/workspace$~', $tunnel)) {
            $tunnel = '';
        }

        return [
            'app' => 'opencode-workspace',
            'version' => self::VERSION,
            'now' => WUtil::isoMs($now),
            'project' => $cfg['title'],
            'names' => implode('|', [$cfg['lead'], ...$cfg['team']]),
            'transcripts' => $scan['exists'],
            'lead' => $lead,
            'team' => $teamOut,
            'freelancers' => $freelancers,
            'feed' => array_map(static fn($f) => $f['e'], $feed),
            'runs' => $histOut,
            'stats' => [
                'active' => count(array_filter($runs, static fn($r) => $r['status'] === 'working')),
                'freelancers' => count(array_filter($freelancers, static fn($f) => $f['state'] === 'working')),
                'total' => count($runs),
                'recent_starts' => $recent,
                'sessions_active' => $activeMains,
            ],
            'spare_desks' => (int) $cfg['spare_desks'],
            'public_url' => $tunnel !== '' ? $tunnel : null,
        ];
    }
}
