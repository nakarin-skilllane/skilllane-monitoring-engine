// Port of skilllane-monitoring/contract/mask/keys.js: the key rule (isSensitiveKey) and its lists.
using System.Collections.Concurrent;
using System.Text;

namespace Ingest.Mask;

public static class Keys
{
    public const string Redacted = "[REDACTED]";
    public const int MaskVersion = 2;
    public const string MaskResourceKey = "skilllane.monitoring.mask";

    private static readonly string[] SensitiveKeys =
    [
        "password", "confirmpassword", "token", "secret", "authorization", "cookie", "session", "passwd", "pwd",
        "apikey", "api_key", "api-key", "credential", "privatekey", "private_key",
    ];

    private static readonly HashSet<string> Words =
    [
        "pass", "pw", "pwd", "pin", "otp", "totp", "cvv", "cvc", "passcode", "passphrase", "sid", "sess", "sig",
        "signature", "auth", "authentication", "oauth", "jwt", "refresh", "creds",
    ];

    private static readonly HashSet<string> KeyQualifiers =
    [
        "api", "access", "secret", "private", "client", "signing", "encryption", "master", "ssh", "hmac", "jwt", "license",
    ];

    private static readonly HashSet<string> Metadata =
    [
        "type", "at", "date", "time", "ts", "changed", "updated", "created", "expires", "expiry", "expired", "exp", "ttl",
        "timeout", "interval", "period", "length", "min", "max", "policy", "required", "enabled", "count", "strength",
        "hint", "name", "consent", "format", "version",
    ];

    private static readonly HashSet<string> Headers = ["authorization", "proxy-authorization", "cookie", "set-cookie"];
    private static readonly HashSet<string> QueryNames = ["code", "key", "ticket"];

    private const int CacheMax = 10_000;
    private const int CacheKeyMax = 64;
    private static readonly ConcurrentDictionary<string, bool> Verdicts = new();

    /// <summary>camelCase / snake_case / kebab-case → lower-case words (keyWords in keys.js).</summary>
    public static List<string> KeyWords(string key)
    {
        // .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        var sb = new StringBuilder(key.Length + 8);
        for (var i = 0; i < key.Length; i++)
        {
            var c = key[i];
            if (i > 0 && IsUpper(c) && (IsLowerOrDigit(key[i - 1]))) sb.Append(' ');
            sb.Append(c);
        }
        var pass1 = sb.ToString();
        sb.Clear();
        for (var i = 0; i < pass1.Length; i++)
        {
            var c = pass1[i];
            // a run of upper-case letters followed by Upper+lower: split before the last upper
            if (i > 0 && IsUpper(c) && IsUpper(pass1[i - 1]) && i + 1 < pass1.Length && IsLower(pass1[i + 1])) sb.Append(' ');
            sb.Append(c);
        }
        var lower = sb.ToString().ToLowerInvariant();
        var words = new List<string>();
        var start = -1;
        for (var i = 0; i <= lower.Length; i++)
        {
            var alnum = i < lower.Length && ((lower[i] >= 'a' && lower[i] <= 'z') || (lower[i] >= '0' && lower[i] <= '9'));
            if (alnum) { if (start < 0) start = i; }
            else if (start >= 0) { words.Add(lower.Substring(start, i - start)); start = -1; }
        }
        return words;
    }

    private static bool IsUpper(char c) => c >= 'A' && c <= 'Z';
    private static bool IsLower(char c) => c >= 'a' && c <= 'z';
    private static bool IsLowerOrDigit(char c) => IsLower(c) || (c >= '0' && c <= '9');

    private static bool Judge(string key)
    {
        var words = KeyWords(key);
        var last = words.Count > 0 ? words[^1] : null;
        if (words.Count > 1 && last != null && Metadata.Contains(last)) return false;
        var lower = key.ToLowerInvariant();
        foreach (var word in SensitiveKeys) if (lower.Contains(word, StringComparison.Ordinal)) return true;
        foreach (var word in words) if (Words.Contains(word)) return true;
        if (last == "key") { foreach (var word in words) if (KeyQualifiers.Contains(word)) return true; return false; }
        if (words.Count == 1 && last != null && last.EndsWith("key", StringComparison.Ordinal))
            return KeyQualifiers.Contains(last.Substring(0, last.Length - 3));
        return false;
    }

    public static bool IsSensitiveKey(string? key)
    {
        if (string.IsNullOrEmpty(key)) return false;
        if (Verdicts.TryGetValue(key, out var known)) return known;
        var verdict = Judge(key);
        if (key.Length <= CacheKeyMax)
        {
            if (Verdicts.Count >= CacheMax) Verdicts.Clear();
            Verdicts[key] = verdict;
        }
        return verdict;
    }

    public static bool IsSensitiveQueryName(string? name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        return QueryNames.Contains(name.ToLowerInvariant()) || IsSensitiveKey(name);
    }

    public static bool IsSensitiveHeader(string? name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        return Headers.Contains(name.ToLowerInvariant()) || IsSensitiveKey(name);
    }
}
