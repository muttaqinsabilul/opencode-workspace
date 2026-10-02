<?php
declare(strict_types=1);

date_default_timezone_set('UTC');
require dirname(__DIR__) . '/lib/php/Config.php';
require dirname(__DIR__) . '/lib/php/Office.php';
require dirname(__DIR__) . '/lib/php/Http.php';

$runtime = dirname(__DIR__);
$projectEnv = (string) getenv('WORKSPACE_PROJECT');
$project = realpath($projectEnv !== '' ? $projectEnv : (string) getcwd());
$storageEnv = (string) getenv('WORKSPACE_STORAGE');
$storage = $storageEnv !== '' ? rtrim($storageEnv, '/') : null;

$send = static function (int $status, array $headers, string $body = ''): never {
    http_response_code($status);
    foreach (WHttp::SECURITY_HEADERS + $headers as $k => $v) {
        header($k . ': ' . $v);
    }
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
        echo $body;
    }
    exit;
};
$text = ['Content-Type' => 'text/plain; charset=utf-8'];

function workspace_registry_file(): ?string
{
    $base = getenv('XDG_CACHE_HOME');
    if (!is_string($base) || trim($base) === '') {
        $home = getenv('HOME');
        if (!is_string($home) || $home === '') {
            $up = getenv('USERPROFILE');
            if (is_string($up) && $up !== '') {
                $home = $up;
            } else {
                $hd = getenv('HOMEDRIVE');
                $hp = getenv('HOMEPATH');
                $home = (is_string($hd) && is_string($hp)) ? ($hd . $hp) : '';
            }
        }
        if (!is_string($home) || $home === '') {
            return null;
        }
        $base = rtrim($home, '/\\') . '/.cache';
    }
    return rtrim($base, '/\\') . '/opencode-workspace/registry.json';
}
function workspace_registry_read(): array
{
    $f = workspace_registry_file();
    if ($f === null || !is_file($f)) {
        return [];
    }
    $raw = @file_get_contents($f);
    if (!is_string($raw)) {
        return [];
    }
    $j = json_decode($raw, true);
    if (is_array($j) && isset($j['projects']) && is_array($j['projects'])) {
        $j = $j['projects'];
    }
    if (!is_array($j)) {
        return [];
    }
    $out = [];
    foreach ($j as $e) {
        if (!is_array($e)) {
            continue;
        }
        $port = (int) ($e['port'] ?? 0);
        $proj = isset($e['project']) && is_string($e['project']) ? substr($e['project'], 0, 256) : '';
        if ($proj === '' || $port < 1 || $port > 65535) {
            continue;
        }
        $out[] = [
            'project' => $proj,
            'port' => $port,
            'title' => isset($e['title']) && is_string($e['title']) ? mb_substr($e['title'], 0, 80) : '',
            'updated' => isset($e['updated']) && is_string($e['updated']) ? substr($e['updated'], 0, 40) : '',
        ];
    }
    return $out;
}
function workspace_registry_touch(string $project, int $port, string $title, int $minAgeSec = 0): void
{
    $v = getenv('WORKSPACE_NO_REGISTRY');
    if ($v !== false && $v !== '' && $v !== '0') {
        return;
    }
    if ($port < 1 || $port > 65535) {
        return;
    }
    $f = workspace_registry_file();
    if ($f === null) {
        return;
    }
    $now = gmdate('Y-m-d\TH:i:s\Z');
    if ($minAgeSec > 0) {
        foreach (workspace_registry_read() as $e) {
            if ($e['project'] === $project) {
                $t = strtotime((string) $e['updated']);
                if ($t !== false && (time() - $t) < $minAgeSec) {
                    return;
                }
                break;
            }
        }
    }
    $dir = dirname($f);
    if (!is_dir($dir)) {
        @mkdir($dir, 0777, true);
    }
    if (!is_dir($dir)) {
        return;
    }
    $clean = mb_substr($title, 0, 80);
    $arr = workspace_registry_read();
    $found = false;
    foreach ($arr as $i => $e) {
        if ($e['project'] === $project) {
            $arr[$i] = ['project' => $project, 'port' => $port, 'title' => $clean, 'updated' => $now];
            $found = true;
        }
    }
    if (!$found) {
        $arr[] = ['project' => $project, 'port' => $port, 'title' => $clean, 'updated' => $now];
    }
    usort($arr, static fn($a, $b): int => strcmp((string) ($b['updated'] ?? ''), (string) ($a['updated'] ?? '')));
    @file_put_contents($f, (string) json_encode(array_slice($arr, 0, 20), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
}

function workspace_badge_svg(?array $state, string $rawLabel): string
{
    $label = preg_replace('/[<>&"\']/', '', $rawLabel);
    $label = $label === null ? '' : mb_substr($label, 0, 24, 'UTF-8');
    if ($label === '') {
        $label = 'opencode-workspace';
    }
    $n = $state !== null ? (int) ($state['stats']['active'] ?? 0) : 0;
    $leadBusy = $state !== null && (string) ($state['lead']['state'] ?? '') === 'working';
    if ($state === null) {
        $right = 'inactive';
        $fill = '#555';
    } elseif ($n > 0) {
        $right = $n . ' active';
        $fill = '#2563eb';
    } elseif ($leadBusy) {
        $right = 'busy';
        $fill = '#2563eb';
    } else {
        $right = 'idle';
        $fill = '#16a34a';
    }
    $tw = static fn(string $s): int => (int) round(mb_strlen($s, 'UTF-8') * 0.6 * 11); 
    $leftW = 12 + $tw($label);
    $rightW = 12 + $tw($right);
    $aria = $label . ': ' . $right;
    $num = static function (float $x): string {
        return rtrim(rtrim(number_format($x, 1, '.', ''), '0'), '.');
    };
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' . ($leftW + $rightW) . '" height="20" role="img" aria-label="' . $aria . '"><title>' . $aria . '</title>'
        . '<rect width="' . $leftW . '" height="20" rx="3" fill="#555"/><rect x="' . $leftW . '" width="' . $rightW . '" height="20" rx="3" fill="' . $fill . '"/>'
        . '<g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle">'
        . '<text x="' . $num($leftW / 2) . '" y="14">' . $label . '</text><text x="' . $num($leftW + $rightW / 2) . '" y="14">' . $right . '</text></g></svg>';
}

if ($project === false) {
    $send(500, $text, 'Project folder not found');
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET' && $method !== 'HEAD') {
    $send(405, $text + ['Allow' => 'GET, HEAD'], 'Method not allowed');
}
if (!WHttp::hostAllowed(isset($_SERVER['HTTP_HOST']) ? (string) $_SERVER['HTTP_HOST'] : null, (string) getenv('WORKSPACE_ALLOWED_HOSTS'))) {
    $send(421, $text, 'Unknown host');
}
$path = rtrim((string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH), '/');

if ($path === '' || $path === '/index.php') {
    $send(302, ['Location' => '/workspace']);
}
if ($path === '/workspace/api/ping') {
    $send(200, ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'],
        (string) json_encode(['app' => 'opencode-workspace', 'project' => substr(md5($project), 0, 12), 'runtime' => 'php']));
}
$cfg = WConfig::load($runtime, $project);
if ($path === '/workspace') {
    $kport = (int) ($_SERVER['SERVER_PORT'] ?? 0);
    if ($kport >= 1 && $kport <= 65535) {
        workspace_registry_touch($project, $kport, (string) ($cfg['title'] ?? ''));
    }
    $page = (string) file_get_contents($runtime . '/views/page.html');
    $json = json_encode(WHttp::pageConfig($cfg), JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_INVALID_UTF8_SUBSTITUTE);
    $send(200, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-cache'], strtr($page, [
        '{{TITLE}}' => htmlspecialchars($cfg['title'], ENT_QUOTES),
        '{{CONFIG_SCRIPT}}' => '<script>window.WORKSPACE = ' . $json . ';</script>',
    ]));
}
if ($path === '/workspace/api/state') {
    $kport = (int) ($_SERVER['SERVER_PORT'] ?? 0);
    if ($kport >= 1 && $kport <= 65535) {
        workspace_registry_touch($project, $kport, (string) ($cfg['title'] ?? ''), 60);
    }
    $state = WOffice::build($project, $storage, $cfg, (int) floor(microtime(true) * 1000));
    $send(200, ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'],
        (string) json_encode($state, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE));
}
if ($path === '/workspace/api/projects') {
    $kport = (int) ($_SERVER['SERVER_PORT'] ?? 0);
    if ($kport >= 1 && $kport <= 65535) {
        workspace_registry_touch($project, $kport, (string) ($cfg['title'] ?? ''));
    }
    $reg = workspace_registry_read();
    $nowMs = (int) floor(microtime(true) * 1000);
    $items = [];
    foreach ($reg as $e) {
        $t = strtotime((string) $e['updated']);
        $stale = !($t !== false && ($nowMs - $t * 1000) <= 10 * 60 * 1000);
        if ($stale) {
            continue;
        }
        $items[] = $e + ['stale' => false, 'current' => ((int) $e['port'] === $kport)];
    }
    usort($items, static function (array $a, array $b): int {
        if ((bool) ($a['current'] ?? false) !== (bool) ($b['current'] ?? false)) {
            return ((bool) ($a['current'] ?? false)) ? -1 : 1;
        }
        return strcmp((string) ($b['updated'] ?? ''), (string) ($a['updated'] ?? ''));
    });
    $seen = [];
    $uniq = [];
    foreach ($items as $e) {
        $p = (int) $e['port'];
        if (isset($seen[$p])) {
            continue;
        }
        $seen[$p] = true;
        $uniq[] = $e;
    }
    $send(200, ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'],
        (string) json_encode(['app' => 'opencode-workspace', 'projects' => $uniq], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE));
}
if ($path === '/workspace/badge.svg') {
    $labelQ = isset($_GET['label']) && is_string($_GET['label']) ? $_GET['label'] : '';
    try {
        $state = WOffice::build($project, $storage, $cfg, (int) floor(microtime(true) * 1000));
        $svg = workspace_badge_svg($state, $labelQ);
    } catch (Throwable $e) {
        $svg = workspace_badge_svg(null, $labelQ);
    }
    $send(200, ['Content-Type' => 'image/svg+xml; charset=utf-8', 'Cache-Control' => 'public, max-age=10'], $svg);
}
if (str_starts_with($path, '/workspace/assets/')) {
    $rel = rawurldecode(substr($path, strlen('/workspace/assets/')));
    $base = realpath(__DIR__ . '/assets');
    $f = str_contains($rel, "\0") ? false : realpath(__DIR__ . '/assets/' . $rel);
    if ($base === false || $f === false || !str_starts_with($f, $base . DIRECTORY_SEPARATOR) || !is_file($f)) {
        $send(404, []);
    }
    $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
    $ctype = $ext === 'js' ? 'text/javascript; charset=utf-8' : ($ext === 'woff2' ? 'font/woff2' : ($ext === 'png' ? 'image/png' : null));
    if ($ctype === null) {
        $send(404, []);
    }
    $etag = '"' . dechex((int) filemtime($f)) . '-' . dechex((int) filesize($f)) . '"';
    $h = ['Content-Type' => $ctype, 'Cache-Control' => 'public, max-age=3600', 'ETag' => $etag];
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        $send(304, $h);
    }
    $send(200, $h + ['Content-Length' => (string) filesize($f)], (string) file_get_contents($f));
}
$send(404, $text, 'Not found');
