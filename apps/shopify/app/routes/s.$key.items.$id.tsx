import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData, useParams, useRevalidator } from "react-router";
import { CHANNELS, photosForChannel, type ChannelId } from "@agentic-selling/core";
import { loadItem, makeListingPhotos, phoneContext } from "../phone.server";
import { confirmDelisted, getSettings, isChannelId, markPosted, markSold, planFor, POST_LINKS } from "../selling.server";
import { identifyStep, listingsStep } from "../ai.server";
import { ROUTES, withTrace } from "@agentic-selling/agents";
import { money, STAGE_LABEL } from "../ui";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const { store, shop } = await phoneContext(params.key);
  const item = await loadItem(store, params.id!);
  const plan = planFor(item, await getSettings(shop));
  const listed = "missing" in plan ? [] : plan.selected;
  const kits = item.listings
    .filter((l) => listed.includes(l.channel))
    .map((l) => {
      const { photos, disclosure } = photosForChannel(item.photos, l.channel);
      return { listing: l, photos, disclosure, postUrl: POST_LINKS[l.channel] ?? null, state: item.channels.find((c) => c.channel === l.channel) ?? null };
    });
  return {
    item,
    plan: "missing" in plan ? null : plan,
    kits,
    processedPhotos: item.photos.some((p) => p.kind !== "original"),
    routes: ROUTES,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { store, shop } = await phoneContext(params.key);
  const item = await loadItem(store, params.id!);
  const settings = await getSettings(shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const channel = String(form.get("channel") ?? "");
  // Every AI step is traced: which model answered, on which provider, how fast, what it cost.
  // "simulate" swaps each primary model for one that doesn't exist, so the gateway really falls back.
  const traced = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const { result, trace } = await withTrace({ simulateOutage: form.get("simulate") === "1" }, fn);
    await store.appendTrace(item.id, trace);
    return result;
  };
  try {
    switch (intent) {
      case "analyze": {
        await traced(() => identifyStep(store, item, item.notes ?? undefined));
        return { ok: "Identified." };
      }
      case "listings": {
        const drafts = await traced(() => listingsStep(store, item, settings));
        return { ok: drafts.length ? "Listings written." : "Add your floor price to get prices and listings." };
      }
      case "photos": {
        const r = await traced(() => makeListingPhotos(store, item, true));
        return { ok: `${r.added} listing-ready photos.`, photoNotes: r };
      }
      case "floor": {
        const floor = Number(form.get("floor"));
        if (!Number.isFinite(floor) || floor <= 0) return { error: "Enter an amount above $0." };
        await store.saveFloor(item.id, floor);
        const drafts = await traced(() => listingsStep(store, { ...item, floorNet: floor }, settings));
        return { ok: `Priced and wrote ${drafts.length} listings.` };
      }
      case "posted":
        if (!isChannelId(channel)) break;
        await markPosted(store, item, channel, String(form.get("url") ?? "") || undefined);
        return { ok: `Marked live on ${CHANNELS[channel].name}.` };
      case "sold": {
        if (!isChannelId(channel)) break;
        const { toDelist } = await markSold(store, item, channel);
        return { ok: toDelist.length ? "Sold and locked. Take the others down below." : "Sold and locked." };
      }
      case "delisted":
        if (!isChannelId(channel)) break;
        await confirmDelisted(store, item, channel);
        return { ok: `${CHANNELS[channel].name} done.` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong." };
  }
  return { error: "Unknown action." };
};

function useShare() {
  const [msg, setMsg] = useState<string | null>(null);
  async function share(urls: string[], title: string) {
    try {
      const files = await Promise.all(
        urls.map(async (u, i) => {
          const b = await (await fetch(u)).blob();
          return new File([b], `${title.slice(0, 30).replace(/\W+/g, "-")}-${i + 1}.jpg`, { type: b.type || "image/jpeg" });
        }),
      );
      if (navigator.canShare?.({ files })) {
        await navigator.share({ files, title });
        return;
      }
      urls.forEach((u) => window.open(u, "_blank"));
    } catch (err) {
      if ((err as Error).name !== "AbortError") setMsg("Couldn't share; long-press each photo to save it.");
    }
  }
  return { share, msg };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

export default function PhoneItem() {
  const { item, plan, kits, processedPhotos, routes } = useLoaderData<typeof loader>();
  const [simulate, setSimulate] = useState(false);
  useEffect(() => {
    try {
      setSimulate(localStorage.getItem("sellie-simulate-outage") === "1");
    } catch {
      // Storage unavailable; the switch just starts off.
    }
  }, []);
  const toggleSimulate = (on: boolean) => {
    setSimulate(on);
    try {
      localStorage.setItem("sellie-simulate-outage", on ? "1" : "0");
    } catch {
      // Not persisted; fine for this visit.
    }
  };
  const { key } = useParams();
  const fetcher = useFetcher<typeof action>();
  const photoFetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const { share, msg } = useShare();
  const started = useRef<Set<string>>(new Set());
  const busy = fetcher.state !== "idle";
  const running = busy ? String(fetcher.formData?.get("intent")) : null;
  const photosRunning = photoFetcher.state !== "idle";

  // New item: identify first, then write listings and make photos at the same time.
  useEffect(() => {
    const start = (f: typeof fetcher, intent: string) => {
      if (started.current.has(intent)) return;
      started.current.add(intent);
      f.submit({ intent, simulate: simulate ? "1" : "0" }, { method: "post" });
    };
    if (!item.facts) {
      if (!busy) start(fetcher, "analyze");
      return;
    }
    if (!busy && item.floorNet !== null && item.listings.length === 0) start(fetcher, "listings");
    if (!photosRunning && !processedPhotos) start(photoFetcher, "photos");
  }, [busy, photosRunning, item.facts, item.floorNet, item.listings.length, processedPhotos, fetcher, photoFetcher]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, fetcher.data]);
  useEffect(() => {
    if (photoFetcher.state === "idle" && photoFetcher.data) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoFetcher.state, photoFetcher.data]);

  const facts = item.facts;
  const toDelist = item.channels.filter((c) => c.status === "needs_delist");
  const live = item.channels.filter((c) => c.status === "active");
  const result = fetcher.data;
  const photoResult = photoFetcher.data;

  const steps = [
    { label: "Reading tags and identifying the item", done: Boolean(facts), active: running === "analyze" },
    { label: "Fixing light, then making a stock-quality cover and a model photo (each scored for honesty and quality)", done: processedPhotos, active: photosRunning },
    { label: "Pricing for each platform from your floor", done: Boolean(plan), active: running === "floor" },
    { label: "Writing a listing for each platform", done: kits.length > 0, active: running === "listings" || running === "floor" },
  ];

  return (
    <>
      <Link to={`/s/${key}`} className="muted" style={{ textDecoration: "none" }}>
        ← All items
      </Link>
      <h1>{facts?.title ?? "New item"}</h1>
      <span className="chip">{STAGE_LABEL[item.stage].label}</span>

      {result && "error" in result && <div className="banner bad">{result.error}</div>}
      {photoResult && "error" in photoResult && <div className="banner bad">Photos: {photoResult.error}</div>}

      {toDelist.length > 0 && (
        <div className="card" style={{ borderColor: "var(--bad)" }}>
          <h2>Take these down now</h2>
          <p className="muted">It sold, so remove the other listings before someone else buys it.</p>
          {toDelist.map((c) => (
            <fetcher.Form method="post" key={c.channel} className="row" style={{ padding: "6px 0" }}>
              <input type="hidden" name="intent" value="delisted" />
              <input type="hidden" name="channel" value={c.channel} />
              <strong style={{ flex: 1 }}>{CHANNELS[c.channel].name}</strong>
              {c.url && (
                <a className="btn" href={c.url} target="_blank" rel="noreferrer">
                  Open
                </a>
              )}
              <button className="btn primary">Done</button>
            </fetcher.Form>
          ))}
        </div>
      )}

      {item.stage !== "sold" && (
        <div className="card">
          <ul className="steps">
            {steps.map((s) => (
              <li key={s.label}>
                <span>{s.done ? "✅" : s.active ? "⏳" : "○"}</span>
                <span className={s.done ? "" : "muted"}>{s.label}</span>
              </li>
            ))}
          </ul>
          {photoResult && "photoNotes" in photoResult && photoResult.photoNotes && (
            <div className="muted" style={{ marginTop: 8 }}>
              {photoResult.photoNotes.retakeTips.map((t) => (
                <div key={t}>↻ {t}</div>
              ))}
              {photoResult.photoNotes.rejected.map((r) => (
                <div key={r.kind}>✗ Left out the {r.kind.replace("ai_", "AI ").replace("_", " ")} photo: {r.why}</div>
              ))}
              {photoResult.photoNotes.missingShots.length > 0 && (
                <div>+ Worth adding: {photoResult.photoNotes.missingShots.join(", ")}</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Photos</h2>
          {processedPhotos && (
            <button
              type="button"
              className="btn"
              disabled={photosRunning}
              onClick={() => photoFetcher.submit({ intent: "photos", simulate: simulate ? "1" : "0" }, { method: "post" })}
            >
              {photosRunning ? "Working…" : "Redo AI photos"}
            </button>
          )}
        </div>
        <div className="grid">
          {item.photos.map((p) => (
            <div className="tile" key={p.url}>
              <img src={p.url} alt={p.alt ?? ""} />
              {p.kind !== "original" && (
                <span className="chip">{p.kind === "ai_model" ? "AI model" : p.kind === "studio" ? "Studio" : p.kind === "enhanced" ? "Fixed" : "AI product shot"}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {facts && (
        <div className="card">
          <h2>What we found</h2>
          <p style={{ margin: "4px 0" }}>
            {[facts.brand, facts.itemType, facts.size && `size ${facts.size}`, facts.colors.join("/")].filter(Boolean).join(" · ")}
          </p>
          <p className="muted" style={{ margin: "4px 0" }}>
            {facts.condition.replaceAll("_", " ")}
            {facts.flaws.length ? ` · ${facts.flaws.join("; ")}` : ""}
          </p>
          <p className="muted" style={{ margin: "4px 0" }}>
            Usually sells for {money(facts.estimatedSoldPriceRange.low)}–{money(facts.estimatedSoldPriceRange.high)}
          </p>
          {facts.questionsForSeller.length > 0 && (
            <div className="banner">
              {facts.questionsForSeller.map((q) => (
                <div key={q}>• {q}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {facts && item.floorNet === null && (
        <fetcher.Form method="post" className="card">
          <input type="hidden" name="intent" value="floor" />
          <input type="hidden" name="simulate" value={simulate ? "1" : "0"} />
          <h2>What's the least you'd take home?</h2>
          <p className="muted">After fees and shipping. We'll price each platform so you never go below it.</p>
          <input name="floor" type="number" inputMode="decimal" min={1} placeholder="e.g. 25" />
          <button className="btn primary block" style={{ marginTop: 12 }} disabled={busy}>
            {running === "floor" ? "Pricing…" : "Price it"}
          </button>
        </fetcher.Form>
      )}

      {plan && (
        <div className="card">
          <h2>Where it sells best</h2>
          <table>
            <thead>
              <tr>
                <th>Platform</th>
                <th>List at</th>
                <th>Accept ≥</th>
                <th>You keep</th>
              </tr>
            </thead>
            <tbody>
              {plan.routes
                .filter((r) => r.selected)
                .map((r) => {
                  const p = plan.prices[r.channel as ChannelId];
                  return (
                    <tr key={r.channel}>
                      <td>{CHANNELS[r.channel].name}</td>
                      <td>{money(p?.listPrice)}</td>
                      <td>{money(p?.minAcceptPrice)}</td>
                      <td>{money(p?.expectedNet)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {kits.map(({ listing, photos, disclosure, postUrl, state }) => {
        const description = [listing.description, disclosure].filter(Boolean).join("\n\n");
        return (
          <div className="card" key={listing.channel}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ margin: 0 }}>{CHANNELS[listing.channel].name}</h2>
              <span className={`chip ${state?.status === "active" ? "ok" : ""}`}>{state?.status === "active" ? "Live" : "Ready"}</span>
            </div>
            <p className="muted">
              List at <strong>{money(listing.price.listPrice)}</strong> · accept offers from {money(listing.price.minAcceptPrice)}
            </p>
            <div className="grid" style={{ marginBottom: 8 }}>
              {photos.slice(0, 6).map((p) => (
                <img key={p.url} src={p.url} alt={p.alt ?? ""} />
              ))}
            </div>
            {listing.title && <div className="copy" style={{ fontWeight: 600 }}>{listing.title}</div>}
            <div className="copy" style={{ marginTop: 8 }}>{description}</div>
            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" className="btn" onClick={() => share(photos.map((p) => p.url), listing.title || "photo")}>
                Save photos
              </button>
              {listing.title && <CopyButton text={listing.title} label="Copy title" />}
              <CopyButton text={description} label="Copy description" />
              {postUrl && (
                <a className="btn primary" href={postUrl} target="_blank" rel="noreferrer">
                  Open {CHANNELS[listing.channel].name}
                </a>
              )}
            </div>
            {msg && <p className="muted">{msg}</p>}
            {item.stage !== "sold" && state?.status !== "active" && (
              <fetcher.Form method="post" style={{ marginTop: 10 }}>
                <input type="hidden" name="intent" value="posted" />
                <input type="hidden" name="channel" value={listing.channel} />
                <input name="url" type="url" placeholder="Paste the listing link (optional)" />
                <button className="btn block" style={{ marginTop: 8 }}>
                  I posted it
                </button>
              </fetcher.Form>
            )}
          </div>
        );
      })}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>AI used for this item</h2>
          <span className="muted">
            {money(item.aiTrace.reduce((sum, c) => sum + (c.costUsd ?? 0), 0))} total
          </span>
        </div>
        {item.aiTrace.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Step</th>
                <th>Answered by</th>
                <th>Time</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {item.aiTrace.map((c, i) => (
                <tr key={i}>
                  <td>{routes[c.task as keyof typeof routes]?.label ?? c.task}</td>
                  <td>
                    {c.servedBy.split("/")[1]}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {c.provider ?? ""}
                      {c.fellBack && <span className="chip warn" style={{ marginLeft: 4 }}>fallback</span>}
                    </div>
                    {c.failed.length > 0 && (
                      <div className="muted" style={{ fontSize: 12 }}>failed: {c.failed.map((f) => f.split("/")[1]).join(", ")}</div>
                    )}
                  </td>
                  <td>{(c.ms / 1000).toFixed(1)}s</td>
                  <td>{c.costUsd !== null ? `$${c.costUsd.toFixed(4)}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <label className="row" style={{ marginTop: 12, fontWeight: 400 }}>
          <input type="checkbox" checked={simulate} onChange={(e) => toggleSimulate(e.target.checked)} />
          <span>Demo: simulate an outage of every primary model (the next AI steps fall back)</span>
        </label>
        <details style={{ marginTop: 8 }}>
          <summary className="muted">How Sellie picks models</summary>
          {Object.entries(routes).map(([task, r]) => (
            <div key={task} style={{ padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
              <strong>{r.label}</strong> <span className="muted">· {r.modality}</span>
              <div style={{ fontSize: 14 }}>{r.models.map((m) => m.split("/")[1]).join(" → ")}</div>
              <div className="muted" style={{ fontSize: 13 }}>{r.why}</div>
              <div className="muted" style={{ fontSize: 12 }}>Providers tried per model: {r.providers.join(", ")}</div>
            </div>
          ))}
        </details>
      </div>

      {item.stage !== "sold" && live.length > 0 && (
        <div className="card">
          <h2>Sold it?</h2>
          <p className="muted">Tap where it sold. We lock it and list what to take down.</p>
          <div className="row">
            {live.map((c) => (
              <fetcher.Form method="post" key={c.channel}>
                <input type="hidden" name="intent" value="sold" />
                <input type="hidden" name="channel" value={c.channel} />
                <button className="btn danger">Sold on {CHANNELS[c.channel].name}</button>
              </fetcher.Form>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
