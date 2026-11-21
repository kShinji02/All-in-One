import { act, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ANA,
  BRUNO,
  installScrollGeometry,
  message,
  renderChat,
  resetMessages,
  ROW_PX,
  uninstallScrollGeometry,
  VIEW_PX,
} from './chat-harness';

const log = () => screen.getByRole('log', { name: 'Mensagens do chat' });
const input = () => screen.getByRole('textbox', { name: 'Mensagem' });
const rows = () => [...log().querySelectorAll<HTMLElement>('[data-key]')];
const texts = () => rows().map((row) => [row.querySelector('p')!.textContent, row.dataset.status]);
const header = () => screen.getByRole('heading', { name: 'Chat' }).closest('header')!;

beforeEach(() => {
  resetMessages();
  installScrollGeometry();
});
afterEach(() => {
  uninstallScrollGeometry();
});

describe('ChatPanel — renderização e histórico', () => {
  it('conectando: indicador e esqueleto de carregamento', () => {
    renderChat();
    expect(within(header()).getByText('Conectando')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Chat: Conectando');
    expect(rows()).toHaveLength(0);
  });

  it('histórico vazio: estado vazio convidativo', async () => {
    const chat = renderChat();
    await chat.openRoom([]);
    expect(within(header()).getByText('Conectado')).toBeInTheDocument();
    expect(screen.getByText('Nenhuma mensagem ainda')).toBeInTheDocument();
    expect(input()).toBeEnabled();
  });

  it('histórico com mensagens: autor, avatar, horário e agrupamento', async () => {
    const chat = renderChat();
    await chat.openRoom([message('oi', BRUNO, { minute: 1 }), message('tudo bem?', BRUNO, { minute: 2 }), message('tudo!', ANA, { minute: 3 })]);
    expect(texts()).toEqual([
      ['oi', 'sent'],
      ['tudo bem?', 'sent'],
      ['tudo!', 'sent'],
    ]);
    const groups = log().querySelectorAll(':scope > ol > li:not([role=separator])');
    expect(groups).toHaveLength(2); // Bruno (2 mensagens) e Ana
    expect(within(groups[0] as HTMLElement).getByText('Bruno')).toBeInTheDocument();
    expect(groups[0]!.querySelector('img')).toHaveAttribute('src', BRUNO.avatarUrl);
    // Horário local (independe do fuso da máquina que roda o teste).
    const local = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date('2026-11-20T15:01:00.000Z'));
    expect(groups[0]!.querySelector('time')).toHaveTextContent(local);
    expect(groups[0]!.querySelector('time')).toHaveAttribute('dateTime', '2026-11-20T15:01:00.000Z');
    expect(screen.getByRole('separator', { name: 'Hoje' })).toBeInTheDocument();
  });

  it('mensagens próprias têm destaque e selo "Você"; as de outros não', async () => {
    const chat = renderChat();
    await chat.openRoom([message('dele', BRUNO), message('minha', ANA)]);
    const [other, own] = [...log().querySelectorAll<HTMLElement>(':scope > ol > li:not([role=separator])')];
    expect(own).toHaveAttribute('data-own', 'true');
    expect(within(own!).getByText('Você')).toBeInTheDocument();
    expect(other).not.toHaveAttribute('data-own');
    expect(within(other!).queryByText('Você')).toBeNull();
  });

  it('texto nunca vira HTML; quebras de linha preservadas; links só http(s), abertos pelo callback', async () => {
    const chat = renderChat();
    await chat.openRoom([message('<img src=x onerror="alert(1)">\nlinha 2 https://ex.com/a. javascript:alert(1)')]);
    const p = rows()[0]!.querySelector('p')!;
    expect(p.querySelector('img')).toBeNull();
    expect(p.textContent).toContain('<img src=x onerror="alert(1)">\nlinha 2');
    expect(p.className).toContain('whitespace-pre-wrap');
    expect(p.className).toContain('[overflow-wrap:anywhere]');
    const links = within(p).getAllByRole('link');
    expect(links).toHaveLength(1);
    // Modo Discord (o harness passa onOpenLink): sem href, abre só pelo callback.
    expect(links[0]).not.toHaveAttribute('href');
    expect(links[0]).toHaveAttribute('data-external-href', 'https://ex.com/a');
    await userEvent.click(links[0]!);
    expect(chat.openLink).toHaveBeenCalledWith('https://ex.com/a');
  });
});

describe('ChatPanel — envio e estados das mensagens', () => {
  it('envio otimista: aparece pending na hora, uma vez, e vira sent na confirmação sem duplicar', async () => {
    const chat = renderChat();
    await chat.openRoom([message('antes', BRUNO)]);
    await userEvent.type(input(), 'nova mensagem{Enter}');

    expect(texts()).toEqual([
      ['antes', 'sent'],
      ['nova mensagem', 'pending'],
    ]);
    expect(screen.getByText('Enviando…')).toBeInTheDocument();
    expect(chat.sent).toHaveLength(1);
    const key = rows()[1]!.dataset.key;

    await chat.confirm(0);
    expect(texts()).toEqual([
      ['antes', 'sent'],
      ['nova mensagem', 'sent'],
    ]);
    expect(rows()[1]!.dataset.key).toBe(key); // mesma linha: sem remontar nem duplicar
    expect(screen.queryByText('Enviando…')).toBeNull();
  });

  it('a pending não mostra horário como se estivesse enviada', async () => {
    const chat = renderChat();
    await chat.openRoom([]);
    await userEvent.type(input(), 'sozinha{Enter}');
    expect(rows()[0]!.closest('li[data-own]')!.querySelector('time')).toBeNull();
  });

  it('failed: indica a falha e oferece tentar de novo (mesmo nonce) e descartar', async () => {
    const chat = renderChat();
    await chat.openRoom([]);
    await userEvent.type(input(), 'vai falhar{Enter}');
    await chat.setConnection({ status: 'stopped', reason: 'retries_exhausted', lastClose: { code: 1006, reason: '', category: 'transient' } });

    expect(texts()).toEqual([['vai falhar', 'failed']]);
    expect(screen.getByText(/Não enviada: a conexão foi encerrada/)).toBeInTheDocument();

    await chat.openRoom([]);
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(chat.sent.map((s) => s.nonce)).toEqual([chat.sent[0]!.nonce, chat.sent[0]!.nonce]);
    expect(texts()).toEqual([['vai falhar', 'pending']]);
  });

  it('rejeitada pelo servidor: sem "tentar de novo"; descartar remove', async () => {
    const chat = renderChat();
    await chat.openRoom([]);
    await userEvent.type(input(), 'longa{Enter}');
    await chat.reject(0);
    expect(screen.getByText(/passou de 500 caracteres/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(rows()).toHaveLength(0);
  });

  it('cliques repetidos em "Tentar de novo" não duplicam a mensagem', async () => {
    const chat = renderChat();
    await chat.openRoom([]);
    await userEvent.type(input(), 'x{Enter}');
    await chat.setConnection({ status: 'stopped', reason: 'limit', lastClose: null });
    await chat.openRoom([]);
    const retry = screen.getByRole('button', { name: 'Tentar de novo' });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(rows()).toHaveLength(1);
    expect(chat.sent).toHaveLength(2);
  });
});

describe('ChatPanel — conexão', () => {
  it('reconectando: histórico continua visível, aviso discreto e campo habilitado', async () => {
    const chat = renderChat();
    await chat.openRoom([message('visível')]);
    await chat.setConnection({ status: 'reconnecting', attempt: 2, delayMs: 1000, lastClose: { code: 1006, reason: '', category: 'transient' } });
    expect(texts()).toEqual([['visível', 'sent']]);
    expect(within(header()).getByText('Reconectando')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Reconectando…');
    expect(input()).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Tentar agora' }));
    expect(chat.reconnect).toHaveBeenCalledOnce();
  });

  it('sem internet: histórico visível, aviso com "Tentar agora" e envio fica pending', async () => {
    const chat = renderChat();
    await chat.openRoom([message('lida antes')]);
    await chat.setConnection({ status: 'offline', lastClose: { code: 1006, reason: '', category: 'transient' } });
    expect(texts()).toEqual([['lida antes', 'sent']]);
    expect(within(header()).getByText('Sem internet')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('O chat reconecta sozinho');
    await userEvent.type(input(), 'sem rede{Enter}');
    expect(texts().at(-1)).toEqual(['sem rede', 'pending']);
    expect(chat.sent).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Tentar agora' }));
    expect(chat.reconnect).toHaveBeenCalledOnce();
  });

  it('enviar durante a reconexão deixa a mensagem pending, sem envio ao socket', async () => {
    const chat = renderChat();
    await chat.openRoom([]);
    await chat.setConnection({ status: 'reconnecting', attempt: 2, delayMs: 1000, lastClose: { code: 1006, reason: '', category: 'transient' } });
    await userEvent.type(input(), 'na fila{Enter}');
    expect(texts()).toEqual([['na fila', 'pending']]);
    expect(chat.sent).toHaveLength(0);
  });

  it('parada definitiva: "Reconectar" usa a API do useChat', async () => {
    const chat = renderChat();
    await chat.openRoom([]);
    await chat.setConnection({ status: 'stopped', reason: 'limit', lastClose: { code: 4029, reason: 'too_many_connections', category: 'limit' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Limite de conexões');
    await userEvent.click(screen.getByRole('button', { name: 'Reconectar' }));
    expect(chat.reconnect).toHaveBeenCalledOnce();
    expect(chat.reload).not.toHaveBeenCalled();
  });

  it('sessão expirada: campo desabilitado e "Recarregar Activity"', async () => {
    const chat = renderChat();
    await chat.openRoom([message('antiga')]);
    await chat.setConnection({ status: 'stopped', reason: 'session_expired', lastClose: { code: 4001, reason: 'invalid_token', category: 'session_expired' } });
    expect(input()).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Recarregar Activity' }));
    expect(chat.reload).toHaveBeenCalledOnce();
    expect(chat.reconnect).not.toHaveBeenCalled();
  });

  it('sem sessão: indisponível, sem banner, campo desabilitado com explicação', async () => {
    const chat = renderChat();
    await chat.setConnection({ status: 'idle' });
    expect(within(header()).getByText('Indisponível')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(input()).toBeDisabled();
    expect(screen.getAllByText(/autenticada no Discord/).length).toBeGreaterThan(0);
  });
});

describe('ChatPanel — rolagem', () => {
  const scrollTo = (top: number) =>
    act(() => {
      log().scrollTop = top;
      fireEvent.scroll(log());
    });
  const distance = () => log().scrollHeight - log().scrollTop - log().clientHeight;
  const many = (n: number) => Array.from({ length: n }, (_, i) => message(`m${i}`, BRUNO, { minute: i }));

  it('ao abrir, mostra as mensagens mais recentes', async () => {
    const chat = renderChat();
    await chat.openRoom(many(10));
    expect(log().scrollTop).toBe(10 * ROW_PX - VIEW_PX);
  });

  it('no fim, acompanha mensagens novas automaticamente', async () => {
    const chat = renderChat();
    await chat.openRoom(many(10));
    await chat.receive(message('nova', BRUNO, { minute: 50 }));
    expect(distance()).toBe(0);
    expect(screen.queryByRole('button', { name: /nova/ })).toBeNull();
  });

  it('lendo mensagens antigas: a posição é preservada e aparece o indicador de novas', async () => {
    const chat = renderChat();
    await chat.openRoom(many(10));
    await scrollTo(100);
    await chat.receive(message('nova 1', BRUNO, { minute: 50 }));
    await chat.receive(message('nova 2', BRUNO, { minute: 51 }));
    expect(log().scrollTop).toBe(100);

    const indicator = screen.getByRole('button', { name: '2 novas mensagens' });
    await userEvent.click(indicator);
    expect(distance()).toBe(0);
    expect(screen.queryByRole('button', { name: /novas mensagens/ })).toBeNull();
  });

  it('longe do fim sem novidades: botão discreto "Ir para as recentes"', async () => {
    const chat = renderChat();
    await chat.openRoom(many(10));
    await scrollTo(0);
    await userEvent.click(screen.getByRole('button', { name: 'Ir para as recentes' }));
    expect(distance()).toBe(0);
  });

  it('voltar ao fim pela rolagem zera o contador', async () => {
    const chat = renderChat();
    await chat.openRoom(many(10));
    await scrollTo(0);
    await chat.receive(message('nova', BRUNO, { minute: 50 }));
    expect(screen.getByRole('button', { name: '1 nova mensagem' })).toBeInTheDocument();
    await scrollTo(10_000);
    expect(screen.queryByRole('button', { name: /nova mensagem/ })).toBeNull();
    // Subir de novo não traz de volta uma contagem antiga.
    await scrollTo(0);
    expect(screen.getByRole('button', { name: 'Ir para as recentes' })).toBeInTheDocument();
  });

  it('a própria mensagem leva ao fim mesmo lendo mensagens antigas', async () => {
    const chat = renderChat();
    await chat.openRoom(many(10));
    await scrollTo(0);
    await userEvent.type(input(), 'minha{Enter}');
    expect(distance()).toBe(0);
  });

  it('reconciliação da otimista não conta como nova nem desloca quem está lendo', async () => {
    const chat = renderChat();
    await chat.openRoom(many(10));
    await userEvent.type(input(), 'minha{Enter}');
    await scrollTo(200);
    await chat.confirm(0);
    expect(log().scrollTop).toBe(200);
    expect(screen.queryByRole('button', { name: /nova/ })).toBeNull();
  });

  it('mensagem mais antiga inserida no meio (histórico mesclado) não conta como nova', async () => {
    const chat = renderChat();
    await chat.openRoom(many(10).slice(5));
    await scrollTo(0);
    await chat.receive(message('antiga', BRUNO, { minute: 0 }));
    expect(screen.queryByRole('button', { name: /nova/ })).toBeNull();
  });

  it('o banner de reconexão não tira do fim quem estava acompanhando', async () => {
    const chat = renderChat();
    await chat.openRoom(many(10));
    expect(distance()).toBe(0);
    await chat.setConnection({ status: 'reconnecting', attempt: 2, delayMs: 1000, lastClose: { code: 1006, reason: '', category: 'transient' } });
    expect(log().clientHeight).toBe(200); // o banner reduziu a área visível
    expect(distance()).toBe(0);
  });

  it('o banner não puxa para o fim quem está lendo mensagens antigas', async () => {
    const chat = renderChat();
    await chat.openRoom(many(10));
    await scrollTo(100);
    await chat.setConnection({ status: 'reconnecting', attempt: 2, delayMs: 1000, lastClose: { code: 1006, reason: '', category: 'transient' } });
    expect(log().scrollTop).toBe(100);
  });
});

describe('ChatPanel — acessibilidade e estrutura', () => {
  it('seção rotulada, histórico como log focável e anúncio de estado', async () => {
    const chat = renderChat();
    await chat.openRoom([message('a')]);
    expect(screen.getByRole('region', { name: 'Chat' })).toBeInTheDocument();
    expect(log()).toHaveAttribute('tabIndex', '0');
    expect(screen.getByRole('status')).toHaveTextContent('Chat: Conectado');
  });

  it('altura limitada à viewport dinâmica e rolagem interna (sem estourar a largura)', async () => {
    const chat = renderChat();
    await chat.openRoom([message('a')]);
    const section = screen.getByRole('region', { name: 'Chat' });
    expect(section.className).toMatch(/h-\[min\(42rem,calc\(100dvh-6rem\)\)\]/);
    expect(section.className).toContain('min-w-0');
    expect(section.className).toContain('overflow-hidden');
    expect(log().className).toContain('overflow-y-auto');
    expect(log().className).toContain('overflow-x-hidden');
  });
});
