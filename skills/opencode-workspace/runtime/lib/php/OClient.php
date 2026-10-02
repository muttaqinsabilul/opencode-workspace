<?php
declare(strict_types=1);

final class WOClient
{
    private static ?array $mem = null;

    public static function resetService(): void
    {
        self::$mem = null;
    }

    private static function serviceFile(): string
    {
        $base = getenv('XDG_CONFIG_HOME');
        if (!is_string($base) || $base === '') {
            $home = getenv('HOME');
            if (!is_string($home) || $home === '') {
                $home = getenv('USERPROFILE');
            }
            $base = (is_string($home) && $home !== '' ? $home : '.') . '/.config';
        }
        return $base . '/opencode/service.json';
    }

    private static function readPassword(): string
    {
        $env = getenv('WORKSPACE_OPENCODE_PASSWORD');
        if (is_string($env) && $env !== '') {
            return $env;
        }
        $raw = @file_get_contents(self::serviceFile());
        if (!is_string($raw)) {
            return '';
        }
        $v = json_decode($raw, true);
        return (is_array($v) && isset($v['password']) && is_string($v['password'])) ? $v['password'] : '';
    }

    private static function statusUrl(string $projectDir): ?string
    {
        $env = getenv('WORKSPACE_OPENCODE_URL');
        if (is_string($env) && $env !== '') {
            return rtrim($env, '/');
        }
        $bin = getenv('WORKSPACE_OPENCODE_BIN');
        if (!is_string($bin) || $bin === '') {
            $bin = 'opencode';
        }
        $cmd = (PHP_OS_FAMILY === 'Windows')
            ? 'cmd /d /s /c ' . $bin . ' service status'
            : escapeshellcmd($bin) . ' service status';
        $old = getcwd();
        if (is_string($old) && $old !== '') {
            @chdir($projectDir);
        }
        $out = [];
        $code = 1;
        @exec($cmd . ' 2>' . (PHP_OS_FAMILY === 'Windows' ? 'NUL' : '/dev/null'), $out, $code);
        if (is_string($old) && $old !== '') {
            @chdir($old);
        }
        if ($code !== 0) {
            return null;
        }
        if (!preg_match('~https?://[^\s"\']+~', implode("\n", $out), $m)) {
            return null;
        }
        return rtrim($m[0], '/');
    }

    private static function cacheFile(?string $storageDir): ?string
    {
        return $storageDir !== null && $storageDir !== '' ? $storageDir . '/oc-service.json' : null;
    }

    public static function getService(string $projectDir, ?string $storageDir): ?array
    {
        if (self::$mem !== null) {
            return self::$mem;
        }
        $cf = self::cacheFile($storageDir);
        if ($cf !== null) {
            $raw = @file_get_contents($cf);
            if (is_string($raw)) {
                $v = json_decode($raw, true);
                if (is_array($v) && isset($v['url']) && is_string($v['url']) && $v['url'] !== '') {
                    $pw = self::readPassword();
                    if ($pw !== '') {
                        self::$mem = ['url' => $v['url'], 'password' => $pw];
                        return self::$mem;
                    }
                    self::$mem = null;
                }
            }
        }
        $url = self::statusUrl($projectDir);
        if ($url === null) {
            return null;
        }
        $pw = self::readPassword();
        if ($pw === '') {
            return null;
        }
        self::$mem = ['url' => $url, 'password' => $pw];
        if ($cf !== null) {
            // 0700/0600 like the Node half; the shared parent (e.g. ~/.cache) is never
            // re-permissioned because mkdir only applies the mode to directories it creates.
            @mkdir(dirname($cf), 0700, true);
            if (@file_put_contents($cf, json_encode(['url' => $url, 'at' => (int) (microtime(true) * 1000)])) !== false) {
                @chmod($cf, 0600);
            }
        }
        return self::$mem;
    }

    public static function apiGet(array $svc, string $apiPath): mixed
    {
        $ctx = stream_context_create(['http' => [
            'method' => 'GET',
            'header' => "Accept: application/json\r\nAuthorization: Basic " . base64_encode('opencode:' . $svc['password']) . "\r\n",
            'timeout' => 8,
            'ignore_errors' => true,
        ]]);
        $raw = @file_get_contents($svc['url'] . $apiPath, false, $ctx);
        if (!is_string($raw)) {
            self::resetService();
            throw new RuntimeException("opencode unreachable: {$apiPath}");
        }
        $status = 0;
        foreach ($http_response_header ?? [] as $h) {
            if (preg_match('~^HTTP/\S+\s+(\d{3})~', $h, $m)) {
                $status = (int) $m[1];
            }
        }
        if ($status !== 200) {
            throw new RuntimeException("opencode {$status} for {$apiPath}");
        }
        return json_decode($raw, true);
    }

    public static function normDir(string $p): string
    {
        return strtolower(rtrim(str_replace('\\', '/', $p), '/'));
    }
}
