import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, Link, redirect, useLoaderData, useNavigation, useParams } from "react-router";
import { isPresenter, phoneContext } from "../phone.server";
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
    canReset: isPresenter(params.key),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { store } = await phoneContext(params.key);
  const form = await request.formData();
  if (form.get("intent") === "reset") {
    // Presenter link only: archive (not delete) everything so the next judge starts clean.
    if (!isPresenter(params.key)) return { error: "Reset is only available on the presenter link." };
    await store.archiveAll();
    return redirect(`/s/${params.key}`);
  }
  const files = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return { error: "Add at least one photo." };
  const notes = String(form.get("notes") ?? "").trim();
  const floor = Number(form.get("floor"));

  const photos = await Promise.all(
    files.slice(0, 10).map(async (f, i) => ({
      data: new Uint8Array(await f.arrayBuffer()),
      mediaType: f.type || "image/jpeg",
      alt: `Photo ${i + 1}`,
      kind: "original" as const,
    })),
  );
  const id = await store.createItem("New item", photos, notes || undefined);
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

export default function PhoneHome() {
  const { items, canReset } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const resetting = navigation.formData?.get("intent") === "reset";
  const { key } = useParams();
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!files.length) return setError("Add at least one photo.");
    setBusy(true);
    setError(null);
    try {
      const form = new FormData(e.currentTarget);
      form.delete("photos");
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
          <label htmlFor="photos">Photos</label>
          <input
            id="photos"
            name="photos"
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
          {files.length > 0 && (
            <div className="grid" style={{ marginTop: 8 }}>
              {files.map((f) => (
                <img key={f.name + f.size} src={URL.createObjectURL(f)} alt="" />
              ))}
            </div>
          )}
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

      {canReset && items.length > 0 && (
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
