import type { Bindings } from "./env";
import type { ModelAuthorityTarget } from "./model-authorization";
import { listRuntimeModels } from "./model-registry";
import { externalAuthorityModel, listExternalModels } from "./external-model";

export type SpaceAuthorityModel = { target: ModelAuthorityTarget; displayName: string };

/** A control-plane catalog of currently available ordinary models in a Space.
 * Model origin affects storage/binding resolution only, not the public key,
 * authority rules, or configuration DTO. No provider network calls. Not used
 * by hot ordinary CRUD, and not a grant of data access. */
export async function listSpaceAuthorityModels(env: Bindings, spaceId: string): Promise<SpaceAuthorityModel[]> {
  const [published,bound] = await Promise.all([listRuntimeModels(env),listExternalModels(env,[spaceId])]);
  const models = new Map<string,SpaceAuthorityModel>();
  for(const model of published) {
    if(model.definition.origin==="external") continue;
    models.set(model.key,{target:model,displayName:model.definition.display.singular});
  }
  for(const binding of bound) {
    const target=externalAuthorityModel(binding);
    models.set(target.key,{target,displayName:binding.businessDefinition?.definition.display.singular??binding.display_name});
  }
  return [...models.values()];
}
