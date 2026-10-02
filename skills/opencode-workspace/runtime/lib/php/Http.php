<?php
declare(strict_types=1);

final class WHttp
{
    public const SECURITY_HEADERS = [
        'X-Robots-Tag' => 'noindex, nofollow',
        'Referrer-Policy' => 'no-referrer',
        'X-Content-Type-Options' => 'nosniff',
        'X-Frame-Options' => 'DENY',
        'Content-Security-Policy' => "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    ];

    public static function pageConfig(array $cfg): array
    {
        return ['title' => $cfg['title'], 'lead' => $cfg['lead'], 'team' => $cfg['team'], 'colors' => $cfg['colors'], 'spare_desks' => $cfg['spare_desks']];
    }

    public static function hostAllowed(?string $hostHeader, string $extra): bool
    {
        if ($hostHeader === null || $hostHeader === '') {
            return true;
        }
        $h = strtolower($hostHeader);
        if (!preg_match('/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/', $h, $m)) {
            return false;
        }
        $name = $m[1];
        if ($name[0] === '[' || preg_match('/^\d{1,3}(\.\d{1,3}){3}$/', $name)) {
            return true;
        }
        if ($name === 'localhost' || str_ends_with($name, '.localhost')) {
            return true;
        }
        foreach (explode(',', strtolower($extra)) as $x) {
            $e = trim($x);
            if ($e !== '' && ($name === $e || (str_starts_with($e, '.') && str_ends_with($name, $e)))) {
                return true;
            }
        }
        return false;
    }
}
