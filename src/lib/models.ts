import type { MessageDTO } from "@/contracts";

type ModelDescription = NonNullable<MessageDTO["aiModel"]>;

/**
 * Splits an OpenRouter model id into the parts a client renders.
 *
 * Ids are `provider/model[:tier]`, so `nvidia/nemotron-3-super-120b-a12b:free` reads as provider
 * `nvidia` and name `nemotron-3-super-120b-a12b`. `id` keeps the full string, because that is what
 * identifies the model to the provider and what a support question would quote.
 *
 * INVARIANT: never throws. An id in an unexpected shape still yields something renderable, since a
 * malformed name must not be what fails a turn that otherwise succeeded.
 */
export function describeModel(modelId: string): ModelDescription {
  const [head, ...rest] = modelId.split("/");
  const hasProvider = rest.length > 0;

  const provider = hasProvider ? head! : "";
  const name = (hasProvider ? rest.join("/") : head!).split(":")[0]!;

  return { id: modelId, name: name || modelId, provider };
}
