<?php
declare(strict_types=1);

final class WUtil
{
    public static function clip(string $s, int $n): string
    {
        return mb_strlen($s) > $n ? mb_substr($s, 0, $n - 1) . '…' : $s;
    }

    // Masks credential shapes in text that reaches the browser. Every pattern is commented with
    // the concrete secret class it covers, and every length threshold exists so ordinary prose
    // and the dashboard's own identifiers (session ids `ses_...`, `sh_...`/`msg_...` record ids,
    // project titles) survive untouched. The alternation order is identical in util.mjs and is
    // significant: the specific patterns run before the broad ones.
    public static function redact(string $s): string
    {
        $s = (string) preg_replace('/(pass(word)?|sandi|secret|token|api[_-]?key)(["\'\s]*[:=]\s*)(\S+)/i', '$1$3•••', $s);
        // mysql/psql client option `--login=user:secret`.
        $s = (string) preg_replace("/--login=['\"]?[^'\"\\s]+/", '--login=•••', $s);
        // Named credential parameters whose keyword is followed by MORE IDENTIFIER CHARACTERS,
        // so the plain keyword rule above can never reach the separator: AWS
        // `aws_secret_access_key` and `aws_session_token`, the shorter `secret_access_key`, Azure
        // storage `SharedAccessKey=` / `AccountKey=` and `SharedAccessSignature=` (SAS URI), OAuth
        // `client_secret`, `private_key`, `sas_token`, and the `pwd=` alias used by SQL Server /
        // IIS / ODBC connection strings. The value stops at `;`/`&` so the rest of a connection
        // string stays readable.
        $s = (string) preg_replace('/\b(aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|secret[_-]?access[_-]?key|shared[_-]?access[_-]?(?:key|signature)|account[_-]?key|client[_-]?secret|private[_-]?key|sas[_-]?token|pwd)(["\'\s]*[:=]\s*)([^\s;&]+)/i', '$1$2•••', $s);
        // Azure SAS URI signature `?...&sig=<base64>` — the query-string spelling of the account
        // key, which is too short a keyword to put in the alternation above, so it needs its own
        // 16-character threshold to stay clear of ordinary `sig=` text. `%` is allowed because a
        // real SAS signature is percent-encoded base64 (`%2F`, `%2B`).
        $s = (string) preg_replace('/\bsig=([A-Za-z0-9+\/_=%-]{16,})/', 'sig=•••', $s);
        // PEM-armoured private keys (RSA / EC / OPENSSH / PGP / ENCRYPTED, with or without the
        // ` BLOCK` suffix). A complete block is consumed up to its END marker; a header without a
        // matching END (truncated paste, or a header line after `firstLine`) still swallows the
        // rest of that line, so no base64 body survives. An END marker on its own is masked too.
        $s = (string) preg_replace('/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[^\s]*)/', '-----BEGIN PRIVATE KEY-----•••', $s);
        $s = (string) preg_replace('/-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/', '-----END PRIVATE KEY-----•••', $s);
        // OpenAI-style `sk-...` API keys.
        $s = (string) preg_replace('/\bsk-[A-Za-z0-9_\-]{8,}/', 'sk-•••', $s);
        // GitHub PAT family, Slack legacy tokens, AWS access key ids.
        $s = (string) preg_replace('/\b(gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/', '•••', $s);
        // Vendor tokens with a fixed prefix: HuggingFace `hf_...`, GitLab `glpat-...`,
        // DigitalOcean `dop_v1_...`, Shopify Admin `shpat_`/`shppa_`/`shpca_`/`shpss_` (32 hex),
        // Slack app-level `xapp-...`. Each threshold is at or below the real token length, so a
        // truncated value is still masked while an ordinary identifier that merely shares the
        // prefix is not.
        $s = (string) preg_replace('/\bhf_[A-Za-z0-9]{16,}/', 'hf_•••', $s);
        $s = (string) preg_replace('/\bglpat-[A-Za-z0-9_\-]{16,}/', 'glpat-•••', $s);
        $s = (string) preg_replace('/\bdop_v1_[A-Za-z0-9]{32,}/', 'dop_v1_•••', $s);
        $s = (string) preg_replace('/\bshp(at|pa|ca|ss)_[a-f0-9]{32,}/i', 'shp$1_•••', $s);
        $s = (string) preg_replace('/\bxapp-[A-Za-z0-9-]{10,}/', 'xapp-•••', $s);
        // Slack incoming-webhook URL: `https://hooks.slack.com/services/T.../B.../token` is a
        // bearer credential, so the whole path is masked and only the host survives.
        $s = (string) preg_replace('/\bhooks\.slack\.com\/services\/[A-Za-z0-9\/_-]{10,}/', 'hooks.slack.com/services/•••', $s);
        // JSON Web Token, i.e. `header.payload.signature` in base64url. `eyJ` is base64url for
        // `{"`, which every JWT header starts with; each segment needs 4 characters so
        // `a.b.c`-style prose is not eaten. An unsigned (`alg:none`) token has an empty third
        // segment, hence `*`.
        $s = (string) preg_replace('/\beyJ[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]{4,}\.[A-Za-z0-9_\-]*/', '•••', $s);
        // `Authorization: Bearer <opaque token>` and `Basic <base64>`. The value must be at least
        // 20 characters and must sit on the same line, so a prose sentence ("bearer of bad news")
        // is left alone while any real credential is masked. The keyword is kept, matching the
        // `sk-•••` style.
        $s = (string) preg_replace('/\b(Bearer|Basic)[ \t]+[A-Za-z0-9._~+\/=\-]{20,}/i', '$1 •••', $s);
        // 40+ hex characters: bare digests, commit hashes, generic API keys.
        $s = (string) preg_replace('/\b[a-f0-9]{40,}\b/i', '•••', $s);
        // e-mail addresses keep their shape: local part and domain are masked separately.
        $s = (string) preg_replace('/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/', '•••@•••', $s);
        // URL userinfo: `scheme://user:password@host`.
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
        // File paths come from tool input, which is attacker-influenced text, so the path is redacted
        // before it is shown or stored: a path segment can be a pasted key or an e-mail address.
        $fp = static function ($v) use ($projectDir) {
            if (!is_string($v) || $v === '') {
                return null;
            }
            return WUtil::redact(WUtil::relPath($v, $projectDir));
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
