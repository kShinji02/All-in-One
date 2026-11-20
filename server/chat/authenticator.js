import { CloseCode, INSTANCE_ID_PATTERN } from "./config.js";
import { createTokenValidator } from "./auth.js";
import { ChatCloseError } from "./errors.js";
import { createInstanceVerifier } from "./instances.js";

/**
 * Autenticador do chat (Etapa 2).
 *
 * Recebe { accessToken, instanceId } do primeiro frame e devolve { user, instanceId }:
 * 1. valida o formato do instanceId (antes de qualquer chamada externa);
 * 2. em paralelo: /users/@me (identidade) e activity-instances (membros da instância);
 * 3. confirma que o usuário autenticado está entre os membros da instância.
 *
 * A identidade (id, nome, avatar) vem exclusivamente das respostas do Discord.
 */
export function createDiscordAuthenticator({ applicationId, botToken, fetchImpl, now, logger, tokenOptions = {}, instanceOptions = {} }) {
  const tokens = createTokenValidator({ fetchImpl, now, logger, ...tokenOptions });
  const instances = createInstanceVerifier({ applicationId, botToken, fetchImpl, now, logger, ...instanceOptions });

  async function authenticate({ accessToken, instanceId }) {
    if (typeof instanceId !== "string" || !INSTANCE_ID_PATTERN.test(instanceId)) {
      throw new ChatCloseError(CloseCode.BAD_REQUEST, "invalid_instance");
    }

    // As duas consultas correm em paralelo, mas a identidade tem prioridade: se o token
    // for inválido, a resposta é sempre invalid_token, mesmo que a consulta da instância
    // termine antes. Assim um cliente não autenticado não descobre se uma instância existe.
    const [userResult, snapshotResult] = await Promise.allSettled([
      tokens.validate(accessToken),
      instances.getSnapshot(instanceId),
    ]);
    if (userResult.status === "rejected") throw userResult.reason;
    if (snapshotResult.status === "rejected") throw snapshotResult.reason;

    const user = userResult.value;
    await instances.assertMember(instanceId, user.id, snapshotResult.value);

    return { user, instanceId };
  }

  // Expostos para testes e para a revalidação periódica da Etapa 3.
  authenticate.tokens = tokens;
  authenticate.instances = instances;
  return authenticate;
}
