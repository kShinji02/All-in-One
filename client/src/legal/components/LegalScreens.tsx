import { CircleAlert, ExternalLink, FileText, LoaderCircle, LogOut, RotateCcw, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { GlassPanel } from '@/components/ui/GlassPanel';
import { useDiscord } from '@/discord/useDiscord';
import { openExternalLink } from '@/discord/external-link';
import type { LegalDocuments, LegalErrorCode } from '@/legal/api';
import { cn } from '@/lib/cn';
import { reloadPage } from '@/lib/reload-page';

const primaryButton =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-neon-600 to-electric-600 px-5 py-2.5 text-sm font-semibold text-white shadow-neon transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:hover:brightness-100 disabled:active:scale-100';
const secondaryButton =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-graphite-100 transition hover:border-white/20 hover:bg-white/[0.06] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40';

const ERROR_MESSAGES: Record<LegalErrorCode, string> = {
  session_expired: 'Sua sessão do Discord expirou. Recarregue a Activity para continuar.',
  version_mismatch: 'Os documentos foram atualizados. Revise as novas versões antes de aceitar.',
  rate_limited: 'Muitas tentativas em pouco tempo. Aguarde um minuto e tente de novo.',
  unavailable: 'Não foi possível falar com o servidor agora. Confira sua conexão e tente de novo.',
  timeout: 'O servidor demorou para responder; ele pode estar sendo iniciado. Aguarde alguns segundos e tente de novo.',
  // Cancelamento interno (tela desmontada ou nova verificação): não chega a ser exibido.
  aborted: 'A verificação foi interrompida. Tente de novo.',
  unexpected: 'O servidor respondeu de forma inesperada. Tente de novo em instantes.',
};

/** Moldura comum das telas do aceite, no estilo dos painéis da Home. */
function LegalFrame({ children, labelledBy }: { children: ReactNode; labelledBy?: string }) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 motion-safe:animate-fade-up">
      <GlassPanel as="section" aria-labelledby={labelledBy} className="p-6 sm:p-8">
        {children}
      </GlassPanel>
    </div>
  );
}

function Brand() {
  return <p className="font-mono text-xs tracking-[0.2em] text-electric-400 uppercase">All-in-One · Discord Activity</p>;
}

/** Depois deste tempo verificando, explica que o servidor pode estar iniciando. */
export const LEGAL_SLOW_HINT_MS = 5_000;

interface LegalCheckingProps {
  children?: ReactNode;
  /** Nova tentativa automática em andamento (servidor iniciando ou instável). */
  retry?: { attempt: number; maxAttempts: number };
}

/** Enquanto a sessão do Discord conecta ou o servidor confere o aceite. */
export function LegalChecking({ children, retry }: LegalCheckingProps) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (children) return;
    const timer = setTimeout(() => setSlow(true), LEGAL_SLOW_HINT_MS);
    return () => clearTimeout(timer);
  }, [children]);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      {children ?? (
        <LegalFrame>
          <Brand />
          {/* Uma única região anunciada: o estado e os avisos de demora/nova tentativa. */}
          <div role="status">
            <p className="mt-4 flex items-center gap-3 text-sm text-graphite-300">
              <LoaderCircle className="size-5 animate-spin text-neon-400" aria-hidden="true" />
              Verificando os Termos de Uso e a Política de Privacidade…
            </p>
            {retry ? (
              <p className="mt-3 text-sm leading-relaxed text-signal-warn">
                O servidor está iniciando ou instável. Tentando de novo automaticamente ({retry.attempt} de {retry.maxAttempts})…
              </p>
            ) : (
              slow && (
                <p className="mt-3 text-sm leading-relaxed text-graphite-400">
                  Está demorando mais que o normal. Se o servidor estava parado, ele leva até um minuto para iniciar.
                </p>
              )
            )}
          </div>
        </LegalFrame>
      )}
    </div>
  );
}

/** Não foi possível confirmar o aceite: nada é liberado. */
export function LegalCheckFailed({ error, onRetry }: { error: LegalErrorCode; onRetry: () => void }) {
  const headingId = useId();
  const expired = error === 'session_expired';
  return (
    <LegalFrame labelledBy={headingId}>
      <Brand />
      <h1 id={headingId} className="mt-3 font-display text-2xl font-semibold tracking-tight text-white">
        Não foi possível verificar o aceite
      </h1>
      <p role="alert" className="mt-3 flex gap-2 text-sm leading-relaxed text-graphite-300">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-signal-warn" aria-hidden="true" />
        {ERROR_MESSAGES[error]}
      </p>
      <p className="mt-2 text-sm text-graphite-400">O chat e os demais recursos ficam bloqueados até a confirmação.</p>
      <div className="mt-6">
        <button type="button" onClick={expired ? reloadPage : onRetry} className={secondaryButton}>
          <RotateCcw className="size-4" aria-hidden="true" />
          {expired ? 'Recarregar Activity' : 'Tentar novamente'}
        </button>
      </div>
    </LegalFrame>
  );
}

interface AcceptanceScreenProps {
  documents: LegalDocuments;
  submitting: boolean;
  error: LegalErrorCode | null;
  /** As versões mudaram enquanto a tela estava aberta. */
  updated: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

/** Tela de aceite da primeira entrada (ou após uma atualização dos documentos). */
export function AcceptanceScreen({ documents, submitting, error, updated, onAccept, onDecline }: AcceptanceScreenProps) {
  const headingId = useId();
  const checkboxId = useId();
  const [checked, setChecked] = useState(false);

  return (
    <LegalFrame labelledBy={headingId}>
      <div className="flex items-start gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-neon-500/25 bg-neon-500/10 text-neon-300" aria-hidden="true">
          <ShieldCheck className="size-5" />
        </span>
        <div className="min-w-0">
          <Brand />
          <h1 id={headingId} className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-white">
            Antes de começar
          </h1>
        </div>
      </div>

      <div className="mt-5 space-y-3 text-sm leading-relaxed text-graphite-300">
        <p>
          Para usar o All-in-One, é preciso <strong className="text-white">aceitar os Termos de Uso</strong>, que trazem as
          regras de uso da Activity.
        </p>
        <p>
          A <strong className="text-white">Política de Privacidade</strong> explica quais dados são tratados, para quê e por
          quanto tempo. Ao continuar, você declara que teve acesso a ela.
        </p>
        <p className="text-graphite-400">
          Este aceite não é um consentimento para o tratamento de dados: as bases legais de cada tratamento estão descritas
          na Política de Privacidade.
        </p>
      </div>

      {updated && (
        <p role="status" className="mt-4 rounded-xl border border-signal-warn/25 bg-signal-warn/10 px-4 py-3 text-sm text-signal-warn">
          {ERROR_MESSAGES.version_mismatch}
        </p>
      )}

      <ul className="mt-5 grid gap-3 sm:grid-cols-2">
        <DocumentLink label="Termos de Uso" url={documents.terms.url} version={documents.terms.version} sha256={documents.terms.sha256} />
        <DocumentLink
          label="Política de Privacidade"
          url={documents.privacy.url}
          version={documents.privacy.version}
          sha256={documents.privacy.sha256}
        />
      </ul>

      <div className="mt-6 flex items-start gap-3 rounded-xl border border-white/[0.07] bg-graphite-950/60 p-4">
        <input
          id={checkboxId}
          type="checkbox"
          checked={checked}
          disabled={submitting}
          onChange={(event) => setChecked(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 cursor-pointer accent-neon-500"
        />
        <label htmlFor={checkboxId} className="cursor-pointer text-sm leading-relaxed text-graphite-100">
          Li e aceito os Termos de Uso e declaro ciência da Política de Privacidade.
        </label>
      </div>

      {error && (
        <p role="alert" className="mt-4 flex gap-2 text-sm leading-relaxed text-signal-danger">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {ERROR_MESSAGES[error]}
        </p>
      )}

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button type="button" onClick={onDecline} disabled={submitting} className={secondaryButton}>
          Recusar
        </button>
        <button type="button" onClick={onAccept} disabled={!checked || submitting} aria-busy={submitting} className={primaryButton}>
          {submitting && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
          {submitting ? 'Registrando…' : 'Aceitar e continuar'}
        </button>
      </div>
    </LegalFrame>
  );
}

/** Abre o documento pela confirmação do próprio Discord (openExternalLink). */
function DocumentLink({ label, url, version, sha256 }: { label: string; url: string; version: string; sha256?: string | null }) {
  const { sdkReady } = useDiscord();
  const [failed, setFailed] = useState(false);

  async function open() {
    const result = await openExternalLink(url, { sdkReady });
    setFailed(result === 'failed' || result === 'unavailable');
  }

  return (
    <li>
      <button
        type="button"
        onClick={open}
        className={cn(
          'group flex w-full items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3 text-left transition',
          'hover:border-electric-400/40 hover:bg-electric-500/[0.06] focus-visible:outline-2 focus-visible:outline-electric-400',
        )}
      >
        <FileText className="size-5 shrink-0 text-electric-400" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-white">{label}</span>
          <span className="block font-mono text-[11px] text-graphite-400">versão {version}</span>
          {sha256 && (
            <span className="block font-mono text-[11px] text-graphite-400" title={`SHA-256: ${sha256}`}>
              SHA-256 {sha256.slice(0, 12)}…
            </span>
          )}
        </span>
        <ExternalLink className="size-4 shrink-0 text-graphite-400 transition group-hover:text-electric-300" aria-hidden="true" />
      </button>
      {failed && (
        <p className="mt-1.5 text-xs break-all text-graphite-400">
          Não foi possível abrir pelo Discord. Endereço: <span className="font-mono text-graphite-300">{url}</span>
        </p>
      )}
    </li>
  );
}

/** Depois de "Recusar": nada é liberado; o usuário pode rever os documentos ou sair. */
export function DeclinedScreen({ onReview, onLeave, exitFailed }: { onReview: () => void; onLeave: () => void; exitFailed: boolean }) {
  const headingId = useId();
  return (
    <LegalFrame labelledBy={headingId}>
      <Brand />
      <h1 id={headingId} className="mt-3 font-display text-2xl font-semibold tracking-tight text-white">
        O uso depende do aceite
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-graphite-300">
        Sem aceitar os Termos de Uso, o chat e os demais recursos do All-in-One ficam indisponíveis. Você pode rever os
        documentos e aceitar quando quiser, ou sair da Activity.
      </p>
      {exitFailed && (
        <p role="alert" className="mt-3 text-sm text-graphite-400">
          Não foi possível fechar pela Activity. Feche pelo próprio Discord.
        </p>
      )}
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <button type="button" onClick={onLeave} className={secondaryButton}>
          <LogOut className="size-4" aria-hidden="true" />
          Sair da Activity
        </button>
        <button type="button" onClick={onReview} className={primaryButton}>
          Rever documentos
        </button>
      </div>
    </LegalFrame>
  );
}
