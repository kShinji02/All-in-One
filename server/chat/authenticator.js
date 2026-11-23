import { CloseCode, INSTANCE_ID_PATTERN } from "./config.js";
import { createTokenValidator } from "./auth.js";
import { ChatCloseError } from "./errors.js";
import { createInstanceVerifier } from "./instances.js";
import { createRetryGate } from "./discord-api.js";

/**
 * Autenticador do chat (Etapa 2).
 *
 * Recebe { accessToken, instanceId } do primeiro frame e devolve { user, instanceId }:
 * 1. valida o formato do instanceId (antes de qualquer chamada externa);
 * 2. /oauth2/@me (identidade e aplicação de origem do token) — e só se o token for válido, activity-instances
 *    (membros da instância, com o token de bot);
 * 3. confirma que o usuário autenticado está entre os membros da instância.
 *
 * A identidade (id, nome, avatar) vem exclusivamente das respostas do Discord.
 */
export function createDiscordAuthenticator({
  applicationId,
  botToken,
  fetchImpl,
  now,
  logger,
  tokenOptions = {},
  instanceOptions = {},
  // Compartilhados com outras rotas (ex.: /api/legal), para usar o mesmo cache e os mesmos tetos.
  gate = createRetryGate({ now }),
  tokens = createTokenValidator({ applicationId, fetchImpl, now, logger, gate, ...tokenOptions }),
}) {
  // Um único registro de bloqueios (429) para as duas consultas.
  const instances = createInstanceVerifier({ applicationId, botToken, fetchImpl, now, logger, gate, ...instanceOptions });

  async function authenticate({ accessToken, instanceId }) {
    if (typeof instanceId !== "string" || !INSTANCE_ID_PATTERN.test(instanceId)) {
      throw new ChatCloseError(CloseCode.BAD_REQUEST, "invalid_instance");
    }

    // Em sequência: um token inválido nunca provoca chamada com o token de bot, e um
    // cliente não autenticado não descobre se uma instância existe.
    const user = await tokens.validate(accessToken);
    const snapshot = await instances.getSnapshot(instanceId);
    await instances.assertMember(instanceId, user.id, snapshot);

    return { user, instanceId };
  }

  // Expostos para testes e para a revalidação periódica da Etapa 3.
  authenticate.tokens = tokens;
  authenticate.instances = instances;
  authenticate.gate = gate;
  return authenticate;
}
