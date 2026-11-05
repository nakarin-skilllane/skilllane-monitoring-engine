// Port of skilllane-monitoring/contract/mask/redis.js: maskRedisKey and maskIdentifier (job ids, message ids).
// redisCommand (the Redis statement rule) is not ported: the mappers never call it.
using System.Text.RegularExpressions;

namespace Ingest.Mask;

public static partial class Redis
{
    private static readonly HashSet<string> SecretPrefixes =
        ["pwreset", "reset", "verify", "verification", "magic", "invite", "confirm", "csrf", "nonce"];

    [GeneratedRegex(@"^[^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff""'{}\[\]]+$")]
    private static partial Regex KeyLike();

    public static string MaskRedisKey(string key)
    {
        if (!key.Contains(':') || !KeyLike().IsMatch(key)) return key;
        var segments = key.Split(':');
        for (var i = 0; i < segments.Length - 1; i++)
        {
            var segment = segments[i];
            if (segment.Length > 0 && (Keys.IsSensitiveKey(segment) || SecretPrefixes.Contains(segment.ToLowerInvariant())))
            {
                var rest = string.Join(':', segments, i + 1, segments.Length - i - 1);
                return rest == Keys.Redacted ? key : string.Join(':', segments, 0, i + 1) + ":" + Keys.Redacted;
            }
        }
        return key;
    }

    public static string MaskIdentifier(string text) => Value.RedactValue(MaskRedisKey(text));

    public static bool IsSensitiveRedisKey(string key) => key.Length > 0 && (Keys.IsSensitiveKey(key) || MaskRedisKey(key) != key);
}
