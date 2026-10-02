<?php
declare(strict_types=1);

final class WUtil
{
    public static function clip(string $s, int $n): string
    {
        return mb_strlen($s) > $n ? mb_substr($s, 0, $n - 1) . '…' : $s;
    }

    public static function redact(string $s): string
    {
        $s = (string) preg_replace('/(pass(word)?|sandi|secret|token|api[_-]?key)(["\'\s]*[:=]\s*)(\S+)/i', '$1$3•••', $s);
        $s = (string) preg_replace("/--login=['\"]?[^'\"\\s]+/", '--login=•••', $s);
        $s = (string) preg_replace('/\bsk-[A-Za-z0-9_\-]{8,}/', 'sk-•••', $s);
        $s = (string) preg_replace('/\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/', '•••', $s);
        $s = (string) preg_replace('/\b[a-f0-9]{40,}\b/i', '•••', $s);
        $s = (string) preg_replace('/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/', '•••@•••', $s);
        return (string) preg_replace('~(\b[a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@~i', '$1•••@', $s);
    }

    public static function firstLine(string $s): string
    {
        foreach (preg_split('/\R/u', $s) ?: [] as $l) {
            $l = trim((string) preg_replace('/[#*`>|_]+/', ' ', $l));
            if ($l !== '') {
                return (string) preg_replace('/[ \t\n\x0B\f\r]+/', ' ', $l);
            }
        }
        return '';
    }

    public static function safeLine(string $s, int $n): string
    {
        return self::clip(self::redact(self::firstLine(self::redact($s))), $n);
    }

    public static function oneLine(string $s, int $n): string
    {
        return self::clip(self::redact(trim((string) preg_replace('/[\t\n\x0B\f\r]+/', ' ', self::redact($s)))), $n);
    }

    public static function tsMs(mixed $s): ?int
    {
        if (!is_string($s) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/', $s, $m)) {
            return null;
        }
        $ms = isset($m[7]) && $m[7] !== '' ? (int) str_pad(substr($m[7], 0, 3), 3, '0') : 0;
        $off = 0;
        if ($m[8] !== 'Z') {
            $off = ($m[8][0] === '-' ? -1 : 1) * ((int) substr($m[8], 1, 2) * 60 + (int) substr($m[8], 4, 2)) * 60000;
        }
        return gmmktime((int) $m[4], (int) $m[5], (int) $m[6], (int) $m[2], (int) $m[3], (int) $m[1]) * 1000 + $ms - $off;
    }

    public static function isoMs(int $ms): string
    {
        $sec = intdiv($ms, 1000);
        $rem = $ms - $sec * 1000;
        if ($rem < 0) {
            $sec--;
            $rem += 1000;
        }
        return gmdate('Y-m-d\TH:i:s', $sec) . '.' . sprintf('%03d', $rem) . 'Z';
    }

    public static function hash(string $s): int
    {
        $h = 7;
        $n = strlen($s);
        for ($i = 0; $i < $n; $i++) {
            $h = ($h * 31 + ord($s[$i])) % 4294967296;
        }
        return $h;
    }

    public static function globDir(string $dir, string $suffix): array
    {
        $names = @scandir($dir);
        if ($names === false) {
            return [];
        }
        $out = [];
        foreach ($names as $n) {
            if ($n === '' || $n[0] === '.' || strlen($n) <= strlen($suffix) || ($suffix !== '' && !str_ends_with($n, $suffix))) {
                continue;
            }
            $out[] = $n;
        }
        usort($out, 'strcmp');
        return array_map(static fn($n) => $dir . '/' . $n, $out);
    }

    public static function mtime(string $f): int
    {
        $t = @filemtime($f);
        return $t === false ? 0 : $t;
    }

    public static function cmp(int|float $a, int|float $b): int
    {
        return $a <=> $b;
    }

    public static function firstToken(string $s): string
    {
        $t = preg_split('/[ \n]+/', trim($s)) ?: [];
        return ($t[0] ?? '') !== '' ? $t[0] : '…';
    }

    public static function relPath(string $p, string $projectDir): string
    {
        if ($projectDir !== '' && ($p === $projectDir || str_starts_with($p, $projectDir . '/') || str_starts_with($p, $projectDir . '\\'))) {
            return str_replace('\\', '/', substr($p, strlen($projectDir) + 1));
        }
        $parts = preg_split('~[/\\\\]~', $p) ?: [];
        $b = end($parts);
        return $b === false || $b === '' ? $p : $b;
    }

    public static function describeTool(string $name, mixed $inp, string $projectDir): array
    {
        $input = (is_array($inp) && ($inp === [] || !array_is_list($inp))) ? $inp : [];
        $str = static fn($k) => isset($input[$k]) && is_string($input[$k]) ? $input[$k] : '';
        $fp = static function ($v) use ($projectDir) {
            if (!is_string($v) || $v === '') {
                return null;
            }
            return WUtil::relPath($v, $projectDir);
        };
        switch ($name) {
            case 'read': {
                $p = $fp($str('path')) ?: 'file';
                return ["Reading {$p}", $fp($str('path'))];
            }
            case 'write': {
                $p = $fp($str('path')) ?: 'file';
                return ["Writing {$p}", $fp($str('path'))];
            }
            case 'edit': {
                $p = $fp($str('path')) ?: 'file';
                return ["Editing {$p}", $fp($str('path'))];
            }
            case 'patch': {
                $files = isset($input['files']) && is_array($input['files']) ? array_values($input['files']) : [];
                $p = count($files) ? $fp(is_string($files[0]) ? $files[0] : null) : null;
                return [$p ? "Patching {$p}" . (count($files) > 1 ? ' (+' . (count($files) - 1) . ')' : '') : 'Patching file', $p];
            }
            case 'shell': {
                $d = self::oneLine($str('description'), 80);
                return ['Running: ' . ($d !== '' ? $d : self::firstToken($str('command')) . ' …'), null];
            }
            case 'grep': {
                $q = self::clip($str('pattern'), 50);
                return [$q !== '' ? "Searching '{$q}'" : 'Searching text', null];
            }
            case 'glob': {
                $q = self::clip($str('pattern'), 60);
                return [$q !== '' ? "Finding file {$q}" : 'Finding files', null];
            }
            case 'webfetch': {
                $u = self::oneLine($str('url'), 80);
                return [$u !== '' ? "Fetching {$u}" : 'Web research', null];
            }
            case 'websearch': {
                $q = self::oneLine($str('query'), 80);
                return [$q !== '' ? "Searching web: {$q}" : 'Web research', null];
            }
            case 'skill': {
                $id = $str('id') !== '' ? $str('id') : $str('name');
                return [$id !== '' ? 'Loading skill ' . self::clip($id, 60) : 'Loading skill', null];
            }
            case 'subagent':
            case 'task': {
                $d = self::oneLine($str('description'), 140);
                return ['Delegating: ' . ($d !== '' ? $d : self::clip($str('agent'), 40)), null];
            }
            case 'question':
                return ['Asking user', null];
            case 'execute':
                return ['Running code', null];
            default:
                return [self::clip($name, 60), null];
        }
    }
}
