import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { Link, Outlet, useLoaderData, useRouteError, isRouteErrorResponse } from "react-router";
import { phoneContext } from "../phone.server";

// Phone app shell for /s/<key>. AI steps can take a minute or two; children inherit this limit.
export const config = { maxDuration: 300 };

export const meta: MetaFunction = () => [
  { title: "Sellie" },
  { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
  { name: "theme-color", content: "#111111" },
];

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const { shop } = await phoneContext(params.key);
  return { key: params.key!, shop };
};

const CSS = `
:root { --bg:#faf9f7; --card:#fff; --ink:#151515; --muted:#6b6b6b; --line:#e7e4df; --accent:#151515; --ok:#1f7a4d; --warn:#9a5b00; --bad:#b42318; --chip:#f1efeb; }
@media (prefers-color-scheme: dark) { :root { --bg:#111; --card:#1b1b1b; --ink:#f3f3f3; --muted:#a3a3a3; --line:#2c2c2c; --accent:#f3f3f3; --chip:#262626; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
.wrap { max-width: 560px; margin: 0 auto; padding: 16px 16px 96px; }
header.top { display:flex; align-items:center; justify-content:space-between; padding: 8px 0 16px; }
header.top a { color: inherit; text-decoration: none; font-weight: 700; font-size: 20px; letter-spacing: -0.02em; }
h1 { font-size: 24px; letter-spacing: -0.02em; margin: 4px 0 12px; }
h2 { font-size: 17px; margin: 0 0 8px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; margin: 12px 0; }
.muted { color: var(--muted); font-size: 14px; }
.btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:44px; padding: 10px 16px; border-radius: 12px; border: 1px solid var(--line); background: var(--card); color: var(--ink); font: inherit; font-weight: 600; text-decoration:none; cursor:pointer; }
.btn.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.btn.danger { color: var(--bad); }
.btn.block { width: 100%; }
.btn[disabled] { opacity: .5; }
.row { display:flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.grid { display:grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.grid img { width:100%; aspect-ratio:1; object-fit:cover; border-radius: 10px; background: var(--chip); display:block; }
.chip { display:inline-block; padding: 2px 8px; border-radius: 999px; background: var(--chip); font-size: 12px; font-weight: 600; }
.chip.ok { color: var(--ok); } .chip.warn { color: var(--warn); } .chip.bad { color: var(--bad); }
.tile { position: relative; }
.tile .chip { position:absolute; left:6px; bottom:6px; background: rgba(0,0,0,.65); color:#fff; }
.tile .remove { position:absolute; top:4px; right:4px; width:28px; height:28px; border-radius:999px; border:0; background: rgba(0,0,0,.65); color:#fff; font-size:18px; line-height:1; cursor:pointer; }
.item { display:flex; gap:12px; align-items:center; color:inherit; text-decoration:none; }
.item img { width:64px; height:64px; object-fit:cover; border-radius:12px; background: var(--chip); flex: none; }
table { width:100%; border-collapse: collapse; font-size: 14px; }
td, th { text-align:left; padding: 8px 4px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
input[type=number], input[type=url], textarea { width:100%; font: inherit; padding: 12px; border-radius: 12px; border:1px solid var(--line); background: var(--bg); color: var(--ink); }
label { display:block; font-weight:600; font-size: 14px; margin: 12px 0 6px; }
.steps { list-style:none; padding:0; margin:0; }
.steps li { padding: 6px 0; display:flex; gap:8px; align-items:center; }
.copy { white-space: pre-wrap; background: var(--bg); border:1px solid var(--line); border-radius: 12px; padding: 12px; font-size: 14px; max-height: 220px; overflow:auto; }
.banner { border-radius: 12px; padding: 12px; margin: 12px 0; background: var(--chip); }
.banner.bad { color: var(--bad); } .banner.ok { color: var(--ok); }
`;

export default function PhoneShell() {
  const { key } = useLoaderData<typeof loader>();
  return (
    <div className="wrap">
      <style>{CSS}</style>
      <header className="top">
        <Link to={`/s/${key}`}>Sellie</Link>
        <span className="muted">sell what you don't need</span>
      </header>
      <Outlet />
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? error.data : error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div className="wrap">
      <style>{CSS}</style>
      <div className="card">
        <h2>Hmm.</h2>
        <p>{String(message)}</p>
      </div>
    </div>
  );
}
