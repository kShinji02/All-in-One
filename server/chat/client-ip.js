/**
 * IP do cliente numa requisição de upgrade do WebSocket, com a mesma regra do
 * "trust proxy" do Express (o mesmo TRUST_PROXY de /api/token):
 *
 * percorre [endereço do socket, ...X-Forwarded-For da direita para a esquerda] e para no
 * primeiro endereço NÃO confiável. Sem proxy confiável (padrão), o resultado é sempre o
 * endereço do socket e X-Forwarded-For é ignorado; com N proxies confiáveis, o que o
 * cliente forjar à esquerda do que os proxies acrescentaram nunca é usado.
 *
 * `trust(addr, index)` é a função compilada pelo Express: `app.get("trust proxy fn")`.
 */
export const TRUST_NONE = () => false;

export function clientIp(req, trust = TRUST_NONE) {
  const socketAddress = req.socket?.remoteAddress ?? "unknown";
  const header = req.headers?.["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : header ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .reverse();
  const chain = [socketAddress, ...forwarded];
  for (let index = 0; index < chain.length - 1; index += 1) {
    if (!trust(chain[index], index)) return chain[index];
  }
  return chain.at(-1);
}
