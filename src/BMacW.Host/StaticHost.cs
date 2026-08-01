using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace BMacW.Host;

// Serve the renderer and its data. Nothing else.
//
// This replaces InpaMac.Api, which is gone: the renderer used to ask a C#
// server to run jobs against EDIABAS, and now our own BEST2 VM decodes them
// in the renderer from JSON we generate. What the app still needs from a
// server is what any web page needs -- files over http:// -- because a
// WKWebView loading file:// gets an opaque origin, where fetch() is blocked
// and the app cannot read its own data.
//
// So this is a file server on an ephemeral loopback port, and the whole API
// surface is now static JSON under dist-web/api (tools/web_export.py), read
// through app/renderer/core/webshim.js. The one thing a static file cannot do --
// touch the cable -- goes through SerialProxy on the native bridge instead.
public static class StaticHost
{
    // Two roots, one URL space: the renderer's own files, and the frozen API
    // tree beside them. Kept separate on disk so a rebuild of either does not
    // disturb the other.
    // `prelude` is JavaScript that must run before ANY of the page's own
    // scripts. WKWebView has document-start user scripts for this; Photino has
    // nothing equivalent, and injecting after load is too late -- index.html's
    // first inline script reads the settings synchronously to pick the theme
    // and the app name before the first paint. Since we serve index.html
    // ourselves, the honest place to put it is in the document.
    public static WebApplication Build(string rendererDir, string dataDir,
                                       Func<string>? prelude = null)
    {
        var builder = WebApplication.CreateBuilder(Array.Empty<string>());
        builder.Logging.ClearProviders();          // no console spam in a GUI app
        builder.WebHost.UseKestrel();
        var app = builder.Build();

        if (prelude != null)
        {
            // Answer the document ourselves, with the prelude spliced in ahead
            // of everything else in <head>. Re-read per request rather than
            // cached: a settings save has to reach the next reload, which is
            // exactly why the macOS host re-injects its user scripts.
            app.Use(async (ctx, next) =>
            {
                string p = ctx.Request.Path.Value ?? "/";
                if (p is "/" or "/index.html")
                {
                    string file = Path.Combine(rendererDir, "index.html");
                    if (File.Exists(file))
                    {
                        string html = await File.ReadAllTextAsync(file);
                        int at = html.IndexOf("<head>", StringComparison.OrdinalIgnoreCase);
                        string tag = $"<script>{prelude()}</script>";
                        html = at >= 0
                            ? html.Insert(at + "<head>".Length, tag)
                            : tag + html;
                        ctx.Response.ContentType = "text/html; charset=utf-8";
                        await ctx.Response.WriteAsync(html);
                        return;
                    }
                }
                await next();
            });
        }

        app.UseDefaultFiles(new DefaultFilesOptions
        {
            FileProvider = new PhysicalFileProvider(rendererDir),
        });
        app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = new PhysicalFileProvider(rendererDir),
            ServeUnknownFileTypes = true,
        });

        if (Directory.Exists(dataDir))
        {
            // PREFER A .gz SIBLING. Job code ships gzipped only -- 456 MB raw
            // against 21 MB -- so a request for foo.json has to be answered
            // from foo.json.gz. Rewrite before the file server looks, and name
            // the encoding so the browser inflates it transparently. This is
            // the same trick ServeDataFile used before it was deleted with the
            // rest of the API.
            app.Use(async (ctx, next) =>
            {
                string path = ctx.Request.Path.Value ?? "";
                if (path.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                    && (ctx.Request.Headers.AcceptEncoding.ToString() ?? "")
                        .Contains("gzip", StringComparison.OrdinalIgnoreCase))
                {
                    string rel = path.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
                    string gz = Path.Combine(dataDir, rel + ".gz");
                    if (File.Exists(gz) && !File.Exists(Path.Combine(dataDir, rel)))
                    {
                        ctx.Response.Headers.ContentEncoding = "gzip";
                        ctx.Request.Path = path + ".gz";
                    }
                }
                await next();
            });

            app.UseStaticFiles(new StaticFileOptions
            {
                FileProvider = new PhysicalFileProvider(dataDir),
                ServeUnknownFileTypes = true,
                DefaultContentType = "application/json",
                OnPrepareResponse = ctx =>
                {
                    if (ctx.File.Name.EndsWith(".gz", StringComparison.Ordinal))
                        ctx.Context.Response.Headers.ContentType = "application/json";
                },
            });
        }

        return app;
    }
}
