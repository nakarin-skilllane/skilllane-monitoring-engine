// The SDK's mask rules against bench/fixture/mask-cases.json (copied to fixture/): every `required` case
// must match bit for bit (the Docker build fails otherwise); `optional` cases are counted and reported.
using System.Text.Json;
using Ingest;
using Ingest.Mask;
using Xunit;
using Xunit.Abstractions;

namespace Ingest.Tests;

public class MaskCasesTests(ITestOutputHelper output)
{
    private static readonly string[] SkippedOptional = ["redisCommand"];

    private sealed record Result(string Rule, int Passed, int Total, List<string> Failures);

    private static readonly Lazy<JsonDocument> Cases = new(() =>
        JsonDocument.Parse(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "fixture", "mask-cases.json"))));

    /// <summary>The rule under test; null = not ported.</summary>
    private static Func<JsonElement, object>? Rule(string name) => name switch
    {
        "redactValue" => c => Value.RedactValue(c.GetString()!),
        "redactText" => c => Value.RedactText(c.GetString()!),
        "isSensitiveKey" => c => Keys.IsSensitiveKey(c.GetString()!),
        "maskSql" => c => Sql.MaskSql(c.GetString()!),
        "maskPathByRoute" => c => Web.MaskPathByRoute(c[0].GetString()!, c[1].GetString()),
        "maskJsonText" => c => Value.MaskJsonText(c.GetString()!),
        "maskUrl" => c => Web.MaskUrl(c.GetString()!),
        "maskQuery" => c => Web.MaskQuery(c.GetString()!),
        "maskHeaderJson" => c => Io.MaskHeaderJson(c.GetString()!, true, int.MaxValue),
        "maskHeaderValue" => c => Web.MaskHeaderValue(c[0].GetString()!, c[1].GetString()!),
        "isSensitiveHeader" => c => Keys.IsSensitiveHeader(c.GetString()!),
        "maskStatement" => c => Io.MaskStatement(c[0].GetString()!, c[1].GetString()!, 65536),
        "maskIdentifier" => c => Redis.MaskIdentifier(c.GetString()!),
        "isThaiNationalId" => c => Value.IsThaiNationalId(c.GetString()!),
        // maskNumber on a string input: not a JS number, so the SDK returns it unchanged
        "maskNumber" => c => c.ValueKind == JsonValueKind.Number ? Value.MaskNumber(c.GetDouble()) : c.GetString()!,
        _ => null,
    };

    private static Result Run(string rule, JsonElement cases)
    {
        var fn = Rule(rule);
        var failures = new List<string>();
        var total = cases.GetArrayLength();
        if (fn == null) return new Result(rule, 0, total, ["not ported"]);
        var passed = 0;
        foreach (var c in cases.EnumerateArray())
        {
            var input = c.GetProperty("input");
            var expected = c.GetProperty("output");
            object actual;
            try { actual = fn(input); }
            catch (Exception e) { failures.Add($"{rule}({input.GetRawText()}) threw {e.GetType().Name}: {e.Message}"); continue; }
            var ok = expected.ValueKind switch
            {
                JsonValueKind.String => actual is string s && s == expected.GetString(),
                JsonValueKind.True => actual is true,
                JsonValueKind.False => actual is false,
                JsonValueKind.Number => actual is double d && d == expected.GetDouble(),
                _ => false,
            };
            if (ok) passed++;
            else failures.Add($"{rule}({input.GetRawText()})\n    expected {expected.GetRawText()}\n    actual   {JsonSerializer.Serialize(actual)}");
        }
        return new Result(rule, passed, total, failures);
    }

    private static List<Result> RunGroup(string group) =>
        Cases.Value.RootElement.GetProperty(group).EnumerateObject().Select(p => Run(p.Name, p.Value)).ToList();

    [Fact]
    public void RequiredRulesMatchTheSdkBitForBit()
    {
        var results = RunGroup("required");
        var failures = results.SelectMany(r => r.Failures).ToList();
        Assert.True(failures.Count == 0, "required mask cases failed:\n" + string.Join("\n", failures));
        Assert.Equal(5, results.Count(r => r.Passed == r.Total));
    }

    [Fact]
    public void Coverage()
    {
        var required = RunGroup("required");
        var optional = RunGroup("optional");
        var requiredRules = required.Count(r => r.Passed == r.Total);
        var optionalRules = optional.Count(r => r.Passed == r.Total);
        var skipped = optional.Where(r => r.Passed != r.Total).Select(r => r.Rule).ToList();
        var line = $"mask: required {requiredRules}/{required.Count} · optional {optionalRules}/{optional.Count} (skipped: {string.Join(", ", skipped)})";
        var cases = $"mask cases: required {required.Sum(r => r.Passed)}/{required.Sum(r => r.Total)} · optional {optional.Sum(r => r.Passed)}/{optional.Sum(r => r.Total)}";
        output.WriteLine(line);
        output.WriteLine(cases);
        foreach (var r in optional.Where(r => r.Failures.Count > 0 && !SkippedOptional.Contains(r.Rule)))
            output.WriteLine($"optional {r.Rule}: {string.Join("; ", r.Failures)}");
        Console.WriteLine(line);
        Console.WriteLine(cases);
        File.WriteAllText(Path.Combine(AppContext.BaseDirectory, "mask-coverage.txt"), line + "\n" + cases + "\n");
        Assert.Equal(5, requiredRules);
    }

    [Theory]
    [InlineData(502.5303149225797, "502.5303149225797")]
    [InlineData(1e21, "1e+21")]
    [InlineData(123456789012345680000d, "123456789012345680000")]
    [InlineData(0.000001, "0.000001")]
    [InlineData(0.0000001, "1e-7")]
    [InlineData(-1.5, "-1.5")]
    [InlineData(100d, "100")]
    [InlineData(1.5e-10, "1.5e-10")]
    public void NumberToStringMatchesJs(double value, string expected) => Assert.Equal(expected, Js.NumberToString(value));

    [Fact]
    public void StringifyEscapesLikeJs()
    {
        Assert.Equal("\"a\\\"b\\\\c\\n\\u001b ไทย 😀 \\ud800 <>&'\"", Js.Stringify("a\"b\\c\n\u001b ไทย 😀 \ud800 <>&'"));
        var tree = Js.Parse("{\"b\":1,\"2\":\"x\",\"a\":[1.0,2.5e3,null,true],\"1\":{}}");
        Assert.Equal("{\"1\":{},\"2\":\"x\",\"b\":1,\"a\":[1,2500,null,true]}", Js.Stringify(tree));
    }

    [Fact]
    public void DateTime64TextMatchesTheContract()
    {
        Assert.Equal("2026-11-05 02:00:03.410722", Mappers.NanosToDateTime64(Int128.Parse("1793844003410722000"), 6));
        Assert.Equal("2026-11-05 02:00:00.239", Mappers.NanosToDateTime64((Int128)Js.DateParse("2026-11-05T02:00:00.239Z") * 1_000_000, 3));
    }
}
