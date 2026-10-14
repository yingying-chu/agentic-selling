import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useLoaderData, useNavigation, useParams } from "react-router";
import { phoneContext } from "../phone.server";
import { STAGE_LABEL } from "../ui";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const { store } = await phoneContext(params.key);
  const { items } = await store.listItems({ limit: 30 });
  return {
    items: items.map((i) => ({
      id: i.id.split("/").pop()!,
      title: i.facts?.title ?? i.title,
      thumb: (i.photos.find((p) => p.kind === "studio") ?? i.photos.find((p) => p.kind === "ai_regenerated") ?? i.photos[0])?.url ?? null,
      stage: i.stage,
      needsDelist: i.channels.filter((c) => c.status === "needs_delist").length,
    })),
    demo: process.env.DEMO_MODE === "1",
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { store } = await phoneContext(params.key);
  const form = await request.formData();
  if (form.get("intent") === "reset") {
    // Demo deployments only: archive (not delete) everything so the next person starts clean.
    if (process.env.DEMO_MODE !== "1") return { error: "Reset is only available in the demo." };
    await store.archiveAll();
    return redirect(`/s/${params.key}`);
  }
  const files = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return { error: "Add at least one photo." };
  const notes = String(form.get("notes") ?? "").trim();
  const floor = Number(form.get("floor"));
  const quantity = Math.min(99, Math.max(1, Math.floor(Number(form.get("quantity")) || 1)));

  const photos = await Promise.all(
    files.slice(0, 10).map(async (f, i) => ({
      data: new Uint8Array(await f.arrayBuffer()),
      mediaType: f.type || "image/jpeg",
      alt: `Photo ${i + 1}`,
      kind: "original" as const,
    })),
  );
  const id = await store.createItem("New item", photos, notes || undefined, quantity);
  if (Number.isFinite(floor) && floor > 0) await store.saveFloor(id, floor);
  return redirect(`/s/${params.key}/items/${id.split("/").pop()}?new=1`);
};

/** Shrinks a phone photo to 1600px JPEG in the browser so uploads stay small and fast. */
async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't read photo"))), "image/jpeg", 0.85),
  );
}

const MAX_PHOTOS = 10;

export default function PhoneHome() {
  const { items, demo } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const resetting = navigation.formData?.get("intent") === "reset";
  const { key } = useParams();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  // Each camera shot or library pick adds to the set, so the seller can mix both.
  function add(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    const next = [...files, ...picked];
    setError(next.length > MAX_PHOTOS ? `Kept the first ${MAX_PHOTOS} photos.` : null);
    setFiles(next.slice(0, MAX_PHOTOS));
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!files.length) return setError("Add at least one photo.");
    setBusy(true);
    setError(null);
    try {
      const form = new FormData(e.currentTarget);
      for (const [i, f] of files.entries()) form.append("photos", await shrink(f), `photo-${i}.jpg`);
      const res = await fetch(`/s/${key}?index`, { method: "POST", body: form, redirect: "follow" });
      if (res.redirected) window.location.href = res.url;
      else setError("Upload didn't go through. Try again?");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <h1>Add an item</h1>
        <p className="muted">Front, back, the tag, and any flaws. Any light is fine; we'll fix it.</p>
        <form onSubmit={submit}>
          <label>
            Photos{files.length > 0 && <span className="muted"> · {files.length} of {MAX_PHOTOS}</span>}
          </label>
          <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={add} />
          <input ref={library} type="file" accept="image/*" multiple hidden onChange={add} />
          <div className="row">
            <button
              type="button"
              className="btn"
              style={{ flex: 1 }}
              disabled={files.length >= MAX_PHOTOS}
              onClick={() => camera.current?.click()}
            >
              {files.length ? "Take another" : "Take photo"}
            </button>
            <button
              type="button"
              className="btn"
              style={{ flex: 1 }}
              disabled={files.length >= MAX_PHOTOS}
              onClick={() => library.current?.click()}
            >
              Choose photos
            </button>
          </div>
          {files.length > 0 && (
            <div className="grid" style={{ marginTop: 8 }}>
              {files.map((f, i) => (
                <div className="tile" key={previews[i]}>
                  <img src={previews[i]} alt={`Photo ${i + 1}`} />
                  <button
                    type="button"
                    className="remove"
                    aria-label={`Remove photo ${i + 1}`}
                    onClick={() => setFiles(files.filter((x) => x !== f))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <label htmlFor="quantity">How many do you have?</label>
          <input id="quantity" name="quantity" type="number" inputMode="numeric" min={1} max={99} step={1} defaultValue={1} />
          <label htmlFor="floor">Least you want to keep after fees ($)</label>
          <input id="floor" name="floor" type="number" inputMode="decimal" min={1} placeholder="e.g. 25" />
          <label htmlFor="notes">Anything the photos don't show? (optional)</label>
          <textarea id="notes" name="notes" rows={2} placeholder="Worn twice, runs small, smoke-free home" />
          {error && <div className="banner bad">{error}</div>}
          <button className="btn primary block" style={{ marginTop: 16 }} disabled={busy}>
            {busy ? "Uploading…" : "Sell this"}
          </button>
        </form>
      </div>

      {items.length > 0 && (
        <div className="card">
          <h2>Your items</h2>
          {items.map((i) => (
            <Link key={i.id} to={`/s/${key}/items/${i.id}`} className="item" style={{ padding: "8px 0" }}>
              {i.thumb ? <img src={i.thumb} alt="" /> : <img alt="" />}
              <div>
                <div style={{ fontWeight: 600 }}>{i.title}</div>
                {i.needsDelist ? (
                  <span className="chip bad">Take down {i.needsDelist} listing{i.needsDelist > 1 ? "s" : ""}</span>
                ) : (
                  <span className="chip">{STAGE_LABEL[i.stage].label}</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {demo && items.length > 0 && (
        <Form
          method="post"
          onSubmit={(e) => {
            if (!window.confirm("Clear every item for the next person? They're archived in Shopify, not deleted.")) e.preventDefault();
          }}
        >
          <input type="hidden" name="intent" value="reset" />
          <button className="btn danger block" disabled={resetting}>
            {resetting ? "Clearing…" : "Reset demo"}
          </button>
        </Form>
      )}
    </>
  );
}
