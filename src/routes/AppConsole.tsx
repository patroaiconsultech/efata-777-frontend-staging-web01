import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AUTH_REQUIRED_EVENT,
  ApiError,
  AgentDefinition,
  ArtifactMetadata,
  ChatMessage,
  Thread,
  ThreadGrant,
  ThreadParticipant,
  ThreadPermissions,
  createInvite,
  getThreadPermissions,
  listThreadParticipants,
  updateThreadParticipantPermissions,
  updateThreadParticipantAccess,
  revokeThreadParticipant,
  createRealtimeCall,
  createThread,
  commitRealtimeTurn,
  downloadArtifact,
  isApiBaseConfigured,
  getDocumentContextProvenance,
  getMe,
  nativeLogout,
  completeHyperCocreatorOnboarding,
  HyperCocreatorMe,
  getRealtimeCapabilities,
  getSttReadiness,
  listAgents,
  listMessages,
  listTeams,
  listThreads,
  messageVoice,
  parseArtifactMetadata,
  postHumanMessage,
  RealtimeCapabilities,
  streamMessage,
  streamRealtimeTurn,
  streamTeamMessage,
  TeamDefinition,
  technicalAgentTarget,
  transcribeVoice,
  uploadAttachment,
  uploadLargeDocumentIntake,
  updateCoCreatorName,
  updateThreadTitle,
} from "../api";
import ArtifactCard from "../components/ArtifactCard";
import SafeMarkdown from "../components/SafeMarkdown";
import PwaInstallButton from "../components/PwaInstallButton";
import { ONBOARDING_DRAFT_KEY } from "./AccessPortal";
import LegacyConversationAdapter from "../features/conversation/LegacyConversationAdapter";
import { LargePasteDecision } from "../features/document-intake/components/LargePasteDecision";
import { useDocumentIntake } from "../features/document-intake/hooks/useDocumentIntake";
import {
  formatConversationTimestamp,
  formatDateTimeTitle,
  formatMessageTimestamp,
} from "../utils/chronology";

const DEFAULT_COCREATOR_LABEL = "Co-Criador";

type VoiceState = "idle" | "recording" | "transcribing" | "review";
type ExecutionMode = "individual" | "team" | "human";
type RealtimeState =
  | "idle"
  | "requesting_microphone"
  | "connecting"
  | "connected"
  | "listening"
  | "transcribing"
  | "executing"
  | "speaking"
  | "interrupted"
  | "disconnecting"
  | "unavailable"
  | "error";
const VOICE_MAX_RECORDING_SECONDS = 90;
const REALTIME_RTP_SAMPLE_INTERVAL_MS = 2500;

/**
 * Only inspect non-sensitive counters. An increasing outbound RTP counter
 * proves local packet emission, NOT delivery or transcription by the provider.
 */
function summarizeOutboundAudioRtp(stats: RTCStatsReport): {
  reports: number;
  packets: number;
  bytes: number;
} {
  let reports = 0;
  let packets = 0;
  let bytes = 0;
  stats.forEach((item) => {
    if (item.type !== "outbound-rtp") return;
    const outbound = item as RTCOutboundRtpStreamStats & { mediaType?: string };
    if (outbound.kind !== "audio" && outbound.mediaType !== "audio") return;
    reports += 1;
    packets += Number(outbound.packetsSent || 0);
    bytes += Number(outbound.bytesSent || 0);
  });
  return { reports, packets, bytes };
}
const ATTACHMENT_ACCEPT =
  ".pdf,.txt,.csv,.md,.markdown,.json,.docx,.xlsx,.pptx";

const VOICE_INPUT_CONSTRAINTS: MediaStreamConstraints = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  },
};

function formatVoiceElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

/** Traduz códigos do backend em mensagens compreensíveis. */
function describe(error: unknown): string {
  const code = error instanceof ApiError ? error.code : String(error ?? "");
  const table: Record<string, string> = {
    API_BASE_URL_NOT_CONFIGURED:
      "A URL da API não está configurada nesta implantação.",
    LLM_NOT_CONFIGURED:
      "A integração de linguagem ainda não está configurada no servidor.",
    LLM_UPSTREAM_ERROR: "O provedor de linguagem falhou. Tente novamente.",
    LLM_EMPTY_RESPONSE: "O provedor devolveu resposta vazia.",
    AUTH_PROVIDER_REQUIRED: "É necessário autenticar-se para continuar.",
    NATIVE_SESSION_REQUIRED: "Sessão ausente ou expirada.",
    BEARER_TOKEN_REQUIRED: "Sessão ausente ou expirada.",
    TOKEN_INACTIVE: "Sessão expirada. Autentique-se novamente.",
    TOKEN_ISSUER_INVALID: "O emissor da sessão não é reconhecido.",
    TOKEN_AUDIENCE_INVALID: "A sessão não foi emitida para esta plataforma.",
    IDENTITY_PROVIDER_UNAVAILABLE:
      "A autenticação da PatroAI está temporariamente indisponível.",
    PRINCIPAL_NOT_PROVISIONED:
      "Sua identidade ainda não está provisionada nesta organização.",
    THREAD_NOT_FOUND: "Conversa não encontrada.",
    THREAD_ACCESS_DENIED: "Você não participa desta conversa.",
    THREAD_READ_ONLY: "Seu perfil nesta conversa é somente leitura.",
    STT_MODEL_NOT_PREWARMED: "Transcrição de voz indisponível no momento.",
    THREAD_RENAME_ROLE_REQUIRED:
      "Apenas o proprietário ou moderador pode renomear esta conversa.",
    THREAD_TITLE_REQUIRED: "Informe um nome para a conversa.",
    INVITE_ROLE_REQUIRED:
      "Apenas o proprietário ou um moderador pode convidar participantes.",
    AGENT_NOT_FOUND: "O agente selecionado não está disponível.",
    ARTIFACTS_DISABLED: "O envio de anexos está desabilitado no servidor.",
    ARTIFACT_FORMAT_UNSUPPORTED:
      "Este formato de documento ainda não está disponível para geração.",
    ARTIFACT_PDF_RENDERER_UNAVAILABLE:
      "O renderizador PDF não está instalado nesta implantação.",
    ARTIFACT_PPTX_RENDERER_UNAVAILABLE:
      "O renderizador PowerPoint não está instalado nesta implantação.",
    ARTIFACT_JSON_INVALID:
      "O conteúdo solicitado não é um JSON válido.",
    ARTIFACT_PDF_VALIDATION_FAILED:
      "O PDF foi gerado, mas não passou na validação final.",
    ARTIFACT_PPTX_VALIDATION_FAILED:
      "O PowerPoint foi gerado, mas não passou na validação final.",
    ARTIFACT_JSON_VALIDATION_FAILED:
      "O JSON gerado não passou na validação final.",
    ARTIFACT_METADATA_INVALID:
      "O servidor informou um artefato, mas a metadata terminal é inválida.",
    ARTIFACT_DOWNLOAD_PATH_INVALID:
      "O caminho de download do artefato é inválido.",
    ARTIFACT_DOWNLOAD_PERMISSION_REQUIRED:
      "Você não tem permissão para baixar este artefato.",
    ARTIFACT_NOT_FOUND: "Este artefato não está mais disponível.",
    ARTIFACT_FILE_NOT_FOUND: "O arquivo do artefato não foi localizado.",
    ARTIFACT_INTEGRITY_MISMATCH:
      "A integridade do artefato não pôde ser confirmada.",
    UPLOAD_PERMISSION_REQUIRED: "Você não tem permissão para enviar arquivos.",
    DOCUMENT_EXTRACTION_UNSUPPORTED:
      "Este tipo de documento ainda não pode ser lido pela plataforma.",
    DOCUMENT_EXTRACTION_FAILED:
      "O documento foi recebido, mas a leitura do conteúdo falhou.",
    DOCUMENT_PPTX_READER_UNAVAILABLE:
      "O leitor de PowerPoint não está instalado nesta implantação.",
    DOCUMENT_PPTX_EXTRACTION_FAILED:
      "Não foi possível extrair o texto do PowerPoint.",
    DOCUMENT_INTEGRITY_ERROR:
      "A integridade do documento não pôde ser confirmada.",
    FILE_TOO_LARGE: "Arquivo acima do tamanho máximo permitido.",
    MIME_TYPE_NOT_ALLOWED: "Tipo de arquivo não permitido.",
    REALTIME_STREAMING_DISABLED: "O streaming em tempo real está desabilitado no servidor.",
    REALTIME_VOICE_DISABLED: "A sessão Realtime de voz ainda não está habilitada.",
    REALTIME_ORCHESTRATION_BRIDGE_REQUIRED:
      "Realtime ainda aguarda a ponte de orquestração canônica da PatroAI.",
    REALTIME_VOICE_OUTPUT_REQUIRED:
      "Realtime precisa de uma voz canônica validada para o agente selecionado.",
    REALTIME_IDEMPOTENCY_KEY_INCOMPLETE:
      "O evento final de voz não possui identidade estável suficiente para criar um turno.",
    REALTIME_TURN_IN_PROGRESS:
      "Este turno Realtime já está sendo processado.",
    REALTIME_PREVIOUS_ATTEMPT_FAILED:
      "Este evento Realtime já falhou e não será duplicado.",
    VIEWER_TTS_NOT_ALLOWED:
      "Seu perfil pode ler a conversa, mas não solicitar síntese de voz.",
    TTS_DISABLED: "A reprodução por voz está desabilitada no servidor.",
    TTS_RATE_LIMITED: "O limite de reprodução por voz foi atingido. Tente novamente em instantes.",
    TTS_COST_GUARD_REJECTED: "Esta resposta excede a política atual de síntese por voz.",
    TTS_TIMEOUT: "A geração de voz excedeu o tempo permitido.",
    VOICE_BINDING_NOT_FOUND: "Este agente ainda não possui uma voz canônica configurada.",
    VOICE_PROFILE_NOT_VALIDATED: "A voz deste agente ainda aguarda validação.",
    TEAM_NOT_FOUND: "O Team selecionado não está disponível.",
    TEAM_MIN_CONTRIBUTORS_REQUIRED: "Selecione o mínimo de especialistas exigido pelo Team.",
    TEAM_MAX_CONTRIBUTORS_EXCEEDED: "O limite de especialistas deste Team foi atingido.",
    TEAM_SELECT_ALL_NOT_SUPPORTED: "Selecionar todos ainda não está liberado para esta formação.",
    TEAM_CHAIR_AS_CONTRIBUTOR_FORBIDDEN: "O coordenador canônico não pode ser executado como especialista.",
    TEAM_ORCHESTRATOR_NOT_ALLOWED: "O coordenador do Team não corresponde ao contrato canônico.",
    TEAM_ORCHESTRATOR_MUST_BE_PARTICIPANT: "O coordenador precisa permanecer no Team.",
    TEAM_AGENT_NOT_ALLOWED: "Um dos agentes não pertence a este Team.",
    TEAM_AGENT_UNAVAILABLE: "Um dos agentes selecionados não está disponível para Team.",
    TEAM_ALL_CONTRIBUTORS_FAILED: "Os especialistas do Team não conseguiram concluir a análise.",
    TEAM_SYNTHESIS_FAILED: "A consolidação final do Team falhou.",
    STT_DISABLED: "A transcrição de voz está desabilitada no servidor.",
    STT_AUDIO_TYPE_NOT_ALLOWED: "Este formato de áudio não é suportado.",
    STT_FILE_TOO_LARGE: "A gravação de voz excede o limite permitido.",
    STT_EMPTY_AUDIO: "Nenhum áudio foi capturado.",
    STT_EMPTY_TRANSCRIPT: "Não foi possível identificar fala nesta gravação.",
    STT_LOCALE_NOT_ALLOWED: "O idioma da gravação não é suportado.",
    STT_DEPENDENCY_NOT_INSTALLED: "O mecanismo de transcrição ainda não está instalado.",
    STT_MODEL_UNAVAILABLE: "O modelo de transcrição está indisponível.",
    STT_TRANSCRIPTION_FAILED: "A transcrição de voz falhou. Tente novamente.",
    STT_TIMEOUT: "A transcrição excedeu o tempo permitido. Tente novamente.",
    STT_CONCURRENCY_LIMIT_REACHED: "O serviço de transcrição está ocupado. Tente novamente.",
    STT_AUDIO_SIGNATURE_MISMATCH: "O conteúdo do áudio não corresponde ao formato informado.",
    PERSISTENCE_FAILED: "A resposta não pôde ser gravada.",
    NETWORK_ERROR: "Falha de rede. Verifique sua conexão.",
  };
  if (table[code]) return table[code];
  if (error instanceof ApiError && error.status === 401)
    return "Sessão ausente ou expirada.";
  return code ? `Não foi possível concluir a ação (${code}).` : "Erro inesperado.";
}

function isRealtimeStreamUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 405 || error.status === 501)
  );
}

function isAbortLike(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    String((error as { name?: unknown }).name || "") === "AbortError"
  );
}

function reportUnexpectedRuntimeError(error: unknown, source: string): void {
  if (isAbortLike(error) || typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("patroai:runtime-error", {
      detail: { source, error },
    }),
  );
}

export default function AppConsole() {
  const [message, setMessage] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [inviteDeliveryStatus, setInviteDeliveryStatus] = useState<"link_only" | "">("");
  const [inviteError, setInviteError] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteHistory, setInviteHistory] = useState<ThreadGrant["history_access"]>("from_join");
  const [inviteAgentId, setInviteAgentId] = useState("orkio");
  const [inviteCanUpload, setInviteCanUpload] = useState(false);
  const [inviteCanRead, setInviteCanRead] = useState(true);
  const [inviteCanWrite, setInviteCanWrite] = useState(true);
  const [inviteCanViewDocuments, setInviteCanViewDocuments] = useState(false);
  const [inviteCanDownloadArtifacts, setInviteCanDownloadArtifacts] = useState(false);
  const [inviteCanGenerateArtifacts, setInviteCanGenerateArtifacts] = useState(false);
  const [inviteAccessHours, setInviteAccessHours] = useState("72");
  const [inviteUnlimitedAccess, setInviteUnlimitedAccess] = useState(false);
  const [participantAccessHours, setParticipantAccessHours] = useState<Record<string, string>>({});
  const [participants, setParticipants] = useState<ThreadParticipant[]>([]);
  const [participantDrafts, setParticipantDrafts] = useState<Record<string, ThreadGrant>>({});
  const [participantsBusy, setParticipantsBusy] = useState(false);
  const [participantAction, setParticipantAction] = useState("");
  const [participantError, setParticipantError] = useState("");
  const [threadPermissions, setThreadPermissions] = useState<ThreadPermissions | null>(null);

  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string>(
    () => new URLSearchParams(window.location.search).get("thread") || "",
  );
  const [showRenameThread, setShowRenameThread] = useState(false);
  const [renameThreadValue, setRenameThreadValue] = useState("");
  const [renameThreadBusy, setRenameThreadBusy] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [authenticated, setAuthenticated] = useState(true);
  const [me, setMe] = useState<HyperCocreatorMe | null>(null);
  const [provisioningBlocked, setProvisioningBlocked] = useState(false);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentDefinition | null>(null);
  const selectedTechnicalTarget = selectedAgent?.slug
    ? technicalAgentTarget(selectedAgent.slug)
    : null;
  const [showAgents, setShowAgents] = useState(false);
  const [showRenameCoCreator, setShowRenameCoCreator] = useState(false);
  const [renameCoCreatorValue, setRenameCoCreatorValue] = useState("");
  const [renameCoCreatorBusy, setRenameCoCreatorBusy] = useState(false);
  const [agentsBusy, setAgentsBusy] = useState(false);
  const [agentsError, setAgentsError] = useState("");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("individual");
  const [teams, setTeams] = useState<TeamDefinition[]>([]);
  const [teamsBusy, setTeamsBusy] = useState(false);
  const [teamsError, setTeamsError] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState("general_team");
  const [teamParticipants, setTeamParticipants] = useState<string[]>([]);
  const [teamRunStatus, setTeamRunStatus] = useState("");
  const [realtimeCapabilities, setRealtimeCapabilities] =
    useState<RealtimeCapabilities | null>(null);
  const [realtimeBusy, setRealtimeBusy] = useState(false);
  const [showRealtimeInfo, setShowRealtimeInfo] = useState(false);
  const [realtimeState, setRealtimeState] = useState<RealtimeState>("idle");
  const [realtimePartialTranscript, setRealtimePartialTranscript] = useState("");
  const [realtimeTransportDiagnostic, setRealtimeTransportDiagnostic] = useState("");
  const [teamSelectionMode, setTeamSelectionMode] =
    useState<"explicit" | "all_eligible">("explicit");
  const [documentProvenanceLabel, setDocumentProvenanceLabel] = useState("");
  const [speakingMessageId, setSpeakingMessageId] = useState("");
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [recentAttachment, setRecentAttachment] = useState("");
  const [artifacts, setArtifacts] = useState<ArtifactMetadata[]>([]);
  const [artifactDownloadBusy, setArtifactDownloadBusy] = useState("");
  const [artifactDownloadErrors, setArtifactDownloadErrors] = useState<
    Record<string, string>
  >({});
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [voiceElapsed, setVoiceElapsed] = useState(0);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceChunksRef = useRef<Blob[]>([]);
  const voiceSessionRef = useRef(0);
  const voiceTimerRef = useRef<number | null>(null);
  const voiceDeadlineRef = useRef<number | null>(null);
  const voiceAbortRef = useRef<AbortController | null>(null);
  const activeThreadRef = useRef(threadId);
  const voiceTranscriptOwnedRef = useRef(false);
  const realtimePeerRef = useRef<RTCPeerConnection | null>(null);
  const realtimeStreamRef = useRef<MediaStream | null>(null);
  const realtimeChannelRef = useRef<RTCDataChannel | null>(null);
  const realtimeConnectionWatchdogRef = useRef<number | null>(null);
  const realtimeStatsTimerRef = useRef<number | null>(null);
  const realtimePreviousPacketsRef = useRef<number | null>(null);
  const realtimeSessionIdRef = useRef("");
  const realtimeSessionThreadRef = useRef("");
  const realtimeSeenFinalIdsRef = useRef<Set<string>>(new Set());
  const realtimeTurnChainRef = useRef<Promise<void>>(Promise.resolve());
  const realtimeLifecycleRef = useRef(0);
  const messagesRequestRef = useRef(0);
  const threadViewportRef = useRef<HTMLElement | null>(null);
  const followLatestRef = useRef(true);
  const scrollToLatestOnLoadRef = useRef(true);
  const messageAudioRef = useRef<HTMLAudioElement | null>(null);
  const messageAudioUrlRef = useRef("");
  const messageVoiceAbortRef = useRef<AbortController | null>(null);
  const realtimeSegmentQueueRef = useRef<
    Array<{ blob: Blob; codec: string; segmentNumber: number }>
  >([]);
  const realtimeSeenSegmentNumbersRef = useRef<Set<number>>(new Set());
  const realtimeSegmentPlayerRef = useRef<HTMLAudioElement | null>(null);
  const realtimeSegmentUrlRef = useRef("");
  const realtimeAudioLifecycleRef = useRef(0);
  const realtimeOutputAbortRef = useRef<AbortController | null>(null);
  const configured = isApiBaseConfigured();
  const authConfigured = configured;
  const accountReady = authenticated && Boolean(me) && !provisioningBlocked;

  function deriveThreadTitle(content: string): string {
    const clean = content
      .replace(/\s+/g, " ")
      .replace(/[\r\n]+/g, " ")
      .trim();
    if (!clean) return "Nova conversa";
    const sentence = clean.split(/(?<=[.!?])\s+/)[0] || clean;
    return sentence.length > 64 ? `${sentence.slice(0, 61).trimEnd()}…` : sentence;
  }

  function scrollConversationToTop() {
    followLatestRef.current = false;
    threadViewportRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  // Only follow new content while the reader remains near the latest message.
  // On thread selection, the first loaded history always opens at the end.
  useLayoutEffect(() => {
    const viewport = threadViewportRef.current;
    if (!viewport) return;
    if (scrollToLatestOnLoadRef.current && messages.length > 0) {
      viewport.scrollTop = viewport.scrollHeight;
      scrollToLatestOnLoadRef.current = false;
    } else if (followLatestRef.current && (messages.length > 0 || streamingText)) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, [threadId, messages, streamingText]);

  const selectThread = useCallback((id: string) => {
    if (id !== activeThreadRef.current) {
      realtimeLifecycleRef.current += 1;
      messagesRequestRef.current += 1;
      cancelVoiceCapture(true);
      stopRealtimeSession();
      stopMessageAudio();
    }
    scrollToLatestOnLoadRef.current = true;
    followLatestRef.current = true;
    activeThreadRef.current = id;
    setThreadId(id);
    setMessages([]);
    setLoading(false);
    setStreamingText("");
    setRecentAttachment("");
    setDocumentProvenanceLabel("");
    setArtifacts([]);
    setArtifactDownloadBusy("");
    setArtifactDownloadErrors({});
    setShowMobileSidebar(false);
    setShowRenameThread(false);
    setError("");
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("thread", id);
    else url.searchParams.delete("thread");
    window.history.replaceState({}, "", url.toString());
  }, []);

  const refreshThreads = useCallback(async () => {
    if (!configured || !authenticated) return;
    try {
      const data = await listThreads();
      setThreads(data.items);
    } catch (err) {
      setError(describe(err));
    }
  }, [authenticated, configured]);

  const refreshMessages = useCallback(async () => {
    if (!configured || !authenticated || !threadId) return;
    const requestedThreadId = threadId;
    const requestId = messagesRequestRef.current + 1;
    messagesRequestRef.current = requestId;
    setLoading(true);
    try {
      const nextMessages = await listMessages(requestedThreadId);
      if (
        requestId !== messagesRequestRef.current ||
        requestedThreadId !== activeThreadRef.current
      ) {
        return;
      }
      setMessages(nextMessages);
    } catch (err) {
      if (
        requestId === messagesRequestRef.current &&
        requestedThreadId === activeThreadRef.current &&
        !isAbortLike(err)
      ) {
        setError(describe(err));
      }
    } finally {
      if (
        requestId === messagesRequestRef.current &&
        requestedThreadId === activeThreadRef.current
      ) {
        setLoading(false);
      }
    }
  }, [authenticated, configured, threadId]);

  const refreshAgents = useCallback(async () => {
    if (!configured || !authenticated) return;
    setAgentsBusy(true);
    setAgentsError("");
    try {
      const catalog = await listAgents(threadId || undefined);
      setAgents(catalog);
      setInviteAgentId((current) =>
        catalog.some((agent) => agent.slug === current) ? current : catalog[0]?.slug ?? "orkio",
      );
      setSelectedAgent((current) => {
        if (!current) return null;
        return catalog.find((agent) => agent.slug === current.slug) ?? null;
      });
    } catch (err) {
      setAgents([]);
      setSelectedAgent(null);
      setAgentsError(describe(err));
    } finally {
      setAgentsBusy(false);
    }
  }, [authenticated, configured, threadId]);

  const refreshTeams = useCallback(async () => {
    if (!configured || !authenticated) return;
    setTeamsBusy(true);
    setTeamsError("");
    try {
      const catalog = (await listTeams()).filter((team) => team.enabled);
      setTeams(catalog);
      const preferred =
        catalog.find((team) => team.team_id === selectedTeamId) ??
        catalog.find((team) => team.team_id === "general_team") ??
        catalog[0] ??
        null;
      if (!preferred) {
        setTeamParticipants([]);
        return;
      }
      setSelectedTeamId(preferred.team_id);
      setTeamSelectionMode("explicit");
      setTeamParticipants((current) => {
        const allowed = new Set(preferred.candidate_contributor_agent_ids);
        const kept = current.filter((id) => allowed.has(id));
        const min = preferred.participant_policy.min_contributors;
        const max = preferred.participant_policy.max_contributors;
        for (const candidate of preferred.candidate_contributor_agent_ids) {
          if (kept.length >= min) break;
          if (!kept.includes(candidate)) kept.push(candidate);
        }
        return kept.slice(0, max);
      });
    } catch (err) {
      setTeams([]);
      setTeamsError(describe(err));
    } finally {
      setTeamsBusy(false);
    }
  }, [authenticated, configured, selectedTeamId]);

  const refreshRealtimeCapabilities = useCallback(async () => {
    if (!configured || !authenticated) return;
    setRealtimeBusy(true);
    try {
      setRealtimeCapabilities(await getRealtimeCapabilities());
    } catch {
      setRealtimeCapabilities(null);
    } finally {
      setRealtimeBusy(false);
    }
  }, [authenticated, configured]);

  useEffect(() => {
    void refreshAgents();
  }, [refreshAgents]);

  useEffect(() => {
    if (!authenticated || !configured) {
      setMe(null);
      setProvisioningBlocked(false);
      return;
    }
    let active = true;
    const bootstrap = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        if (params.get("onboarding") === "1") {
          const raw = sessionStorage.getItem(ONBOARDING_DRAFT_KEY);
          if (raw) {
            const draft = JSON.parse(raw) as {
              grant: string;
              co_creator_name: string;
              onboarding_goal?: string | null;
            };
            await completeHyperCocreatorOnboarding(draft);
            sessionStorage.removeItem(ONBOARDING_DRAFT_KEY);
            params.delete("onboarding");
            const query = params.toString();
            window.history.replaceState(
              null,
              "",
              `${window.location.pathname}${query ? `?${query}` : ""}`,
            );
          }
        }
        const profile = await getMe();
        if (active) {
          setMe(profile);
          setProvisioningBlocked(false);
        }
      } catch (err) {
        if (active) {
          if (err instanceof ApiError && err.status === 401) {
            setAuthenticated(false);
            setMe(null);
            setProvisioningBlocked(false);
          } else {
            setProvisioningBlocked(
              err instanceof ApiError && err.code === "PRINCIPAL_NOT_PROVISIONED",
            );
            setError(describe(err));
          }
        }
      }
    };
    void bootstrap();
    return () => { active = false; };
  }, [authenticated, configured]);


  useEffect(() => {
    setExecutionMode("individual");
    setTeams([]);
  }, []);

  useEffect(() => {
    void refreshRealtimeCapabilities();
  }, [refreshRealtimeCapabilities]);

  useEffect(() => {
    if (showAgents && accountReady) void refreshTeams();
  }, [accountReady, refreshTeams, showAgents]);

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  useEffect(() => {
    setShowInvite(false);
    setParticipants([]);
    setParticipantDrafts({});
    setExecutionMode("individual");
  }, [threadId]);

  useEffect(() => {
    let active = true;
    setThreadPermissions(null);
    if (!threadId || !accountReady) return () => { active = false; };
    void getThreadPermissions(threadId)
      .then((permissions) => { if (active) setThreadPermissions(permissions); })
      .catch((err) => { if (active) setError(describe(err)); });
    return () => { active = false; };
  }, [threadId, accountReady]);

  useEffect(() => {
    void refreshMessages();
  }, [refreshMessages]);

  // Lightweight refresh for human conversation; no AI, no persistent socket.
  // Ignore late responses after switching threads or leaving human mode.
  useEffect(() => {
    if (!accountReady || !threadId || executionMode !== "human" ||
        !threadPermissions?.can_read_messages) return;
    let disposed = false;
    let pending = false;
    const currentThreadId = threadId;
    const tick = async () => {
      if (pending || sending || document.hidden) return;
      pending = true;
      try {
        const items = await listMessages(currentThreadId);
        if (!disposed && activeThreadRef.current === currentThreadId) {
          setMessages(items);
        }
      } catch (err) {
        if (!disposed && !isAbortLike(err)) setError(describe(err));
      } finally {
        pending = false;
      }
    };
    const intervalId = window.setInterval(() => void tick(), 5000);
    return () => { disposed = true; window.clearInterval(intervalId); };
  }, [accountReady, executionMode, sending, threadId, threadPermissions?.can_read_messages]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      voiceSessionRef.current += 1;
      voiceAbortRef.current?.abort();
      if (voiceTimerRef.current !== null) {
        window.clearInterval(voiceTimerRef.current);
        voiceTimerRef.current = null;
      }
      if (voiceDeadlineRef.current !== null) {
        window.clearTimeout(voiceDeadlineRef.current);
        voiceDeadlineRef.current = null;
      }
      const recorder = voiceRecorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
      voiceRecorderRef.current = null;
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
      voiceStreamRef.current = null;
      voiceChunksRef.current = [];
      if (realtimeStatsTimerRef.current !== null) {
        window.clearInterval(realtimeStatsTimerRef.current);
        realtimeStatsTimerRef.current = null;
      }
      realtimeChannelRef.current?.close();
      realtimeChannelRef.current = null;
      realtimePeerRef.current?.close();
      realtimePeerRef.current = null;
      realtimeStreamRef.current?.getTracks().forEach((track) => track.stop());
      realtimeStreamRef.current = null;
      realtimeOutputAbortRef.current?.abort();
      realtimeOutputAbortRef.current = null;
      stopRealtimeSegmentAudio();
      messageVoiceAbortRef.current?.abort();
      messageVoiceAbortRef.current = null;
      const activeAudio = messageAudioRef.current;
      if (activeAudio) {
        activeAudio.pause();
        activeAudio.src = "";
      }
      messageAudioRef.current = null;
      if (messageAudioUrlRef.current) URL.revokeObjectURL(messageAudioUrlRef.current);
      messageAudioUrlRef.current = "";
    };
  }, []);

  useEffect(() => {
    const handleAuthRequired = () => setAuthenticated(false);
    window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
    return () =>
      window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
  }, []);

  function requireAuthenticated(): boolean {
    if (authenticated) return true;
    setError(
      authConfigured
        ? "Autentique-se para continuar."
        : "A API ainda não está configurada nesta implantação.",
    );
    return false;
  }

  function requireProvisioned(): boolean {
    if (!requireAuthenticated()) return false;
    if (!me || provisioningBlocked) {
      setError(
        "Sua conta foi autenticada, mas ainda precisa ser ativada na organização PatroAI. Use o portal de ativação para concluir o acesso.",
      );
      return false;
    }
    return true;
  }

  function stopVoiceTracks() {
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    voiceStreamRef.current = null;
  }

  function clearVoiceTimer() {
    if (voiceTimerRef.current !== null) {
      window.clearInterval(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
    if (voiceDeadlineRef.current !== null) {
      window.clearTimeout(voiceDeadlineRef.current);
      voiceDeadlineRef.current = null;
    }
  }

  function cancelVoiceCapture(clearTranscript = false) {
    const ownsComposerTranscript = voiceTranscriptOwnedRef.current;
    voiceSessionRef.current += 1;
    voiceAbortRef.current?.abort();
    voiceAbortRef.current = null;
    clearVoiceTimer();

    const recorder = voiceRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      recorder.stop();
    }
    voiceRecorderRef.current = null;
    stopVoiceTracks();
    voiceChunksRef.current = [];
    setVoiceState("idle");
    setVoiceElapsed(0);
    voiceTranscriptOwnedRef.current = false;
    if (clearTranscript && ownsComposerTranscript) setMessage("");
  }

  async function transcribeRecordedVoice(
    sessionId: number,
    recordThreadId: string,
    mimeType: string,
  ) {
    clearVoiceTimer();
    stopVoiceTracks();
    voiceRecorderRef.current = null;

    if (sessionId !== voiceSessionRef.current) return;

    const chunks = voiceChunksRef.current;
    voiceChunksRef.current = [];
    const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
    if (!blob.size) {
      setVoiceState("idle");
      setError(describe(new ApiError(0, "STT_EMPTY_AUDIO")));
      return;
    }

    setVoiceState("transcribing");
    setNotice("");
    const controller = new AbortController();
    voiceAbortRef.current = controller;
    try {
      const result = await transcribeVoice(
        recordThreadId,
        blob,
        "auto",
        controller.signal,
      );
      if (
        sessionId !== voiceSessionRef.current ||
        recordThreadId !== activeThreadRef.current
      ) {
        return;
      }
      voiceTranscriptOwnedRef.current = true;
      setMessage(result.transcript);
      setVoiceState("review");
      setNotice("Transcrição pronta. Revise o texto antes de enviar.");
    } catch (err) {
      if (sessionId !== voiceSessionRef.current) return;
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(describe(err));
      }
      setVoiceState("idle");
    } finally {
      if (sessionId === voiceSessionRef.current) {
        voiceAbortRef.current = null;
      }
    }
  }

  async function startVoiceRecording() {
    if (!requireProvisioned()) return;
    if (!threadId) {
      setError("Crie ou selecione uma conversa antes de gravar.");
      return;
    }

    try {
      const readiness = await getSttReadiness();
      if (!readiness.ready) {
        setError("Transcrição de voz indisponível no momento.");
        return;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setError("Transcrição de voz indisponível no momento.");
        return;
      }
      setError(describe(err));
      return;
    }

    if (
      typeof MediaRecorder === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setError("Este navegador não oferece gravação de voz compatível.");
      return;
    }

    setError("");
    setNotice("");
    const sessionId = voiceSessionRef.current + 1;
    voiceSessionRef.current = sessionId;
    const recordThreadId = threadId;

    try {
      const stream = await navigator.mediaDevices.getUserMedia(VOICE_INPUT_CONSTRAINTS);
      if (sessionId !== voiceSessionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ];
      const mimeType =
        typeof MediaRecorder.isTypeSupported === "function"
          ? candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
          : undefined;
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      voiceStreamRef.current = stream;
      voiceRecorderRef.current = recorder;
      voiceChunksRef.current = [];
      setVoiceElapsed(0);

      recorder.ondataavailable = (event) => {
        if (sessionId === voiceSessionRef.current && event.data.size > 0) {
          voiceChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        if (sessionId !== voiceSessionRef.current) return;
        setError("A gravação de voz foi interrompida.");
        cancelVoiceCapture();
      };
      recorder.onstop = () => {
        void transcribeRecordedVoice(
          sessionId,
          recordThreadId,
          recorder.mimeType || mimeType || "audio/webm",
        );
      };

      recorder.start(250);
      setVoiceState("recording");
      voiceTimerRef.current = window.setInterval(
        () =>
          setVoiceElapsed((current) =>
            Math.min(current + 1, VOICE_MAX_RECORDING_SECONDS),
          ),
        1000,
      );
      voiceDeadlineRef.current = window.setTimeout(() => {
        if (sessionId !== voiceSessionRef.current) return;
        const activeRecorder = voiceRecorderRef.current;
        if (!activeRecorder || activeRecorder.state === "inactive") return;
        setNotice(
          `Limite de ${VOICE_MAX_RECORDING_SECONDS}s atingido. Transcrevendo…`,
        );
        clearVoiceTimer();
        activeRecorder.stop();
      }, VOICE_MAX_RECORDING_SECONDS * 1000);
    } catch (err) {
      cancelVoiceCapture();
      const name =
        err && typeof err === "object" && "name" in err
          ? String((err as { name?: unknown }).name || "")
          : "";
      setError(
        name === "NotAllowedError"
          ? "Permissão do microfone negada."
          : "Não foi possível iniciar o microfone.",
      );
    }
  }

  function stopVoiceRecording() {
    const recorder = voiceRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    clearVoiceTimer();
    recorder.stop();
  }

  function handleVoiceButton() {
    if (voiceState === "recording") {
      stopVoiceRecording();
      return;
    }
    if (voiceState === "transcribing") return;
    void startVoiceRecording();
  }

  function stopMessageAudio() {
    messageVoiceAbortRef.current?.abort();
    messageVoiceAbortRef.current = null;
    const audio = messageAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    messageAudioRef.current = null;
    if (messageAudioUrlRef.current) {
      URL.revokeObjectURL(messageAudioUrlRef.current);
      messageAudioUrlRef.current = "";
    }
    setSpeakingMessageId("");
  }

  function stopRealtimeSegmentAudio() {
    realtimeAudioLifecycleRef.current += 1;
    realtimeSegmentQueueRef.current = [];
    realtimeSeenSegmentNumbersRef.current.clear();
    const audio = realtimeSegmentPlayerRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
    }
    realtimeSegmentPlayerRef.current = null;
    if (realtimeSegmentUrlRef.current) {
      URL.revokeObjectURL(realtimeSegmentUrlRef.current);
      realtimeSegmentUrlRef.current = "";
    }
  }

  function enqueueRealtimeAudioSegment(
    segment: { blob: Blob; codec: string; segmentNumber: number },
    lifecycleId: number,
  ) {
    if (lifecycleId !== realtimeLifecycleRef.current) return;
    if (realtimeSeenSegmentNumbersRef.current.has(segment.segmentNumber)) return;
    realtimeSeenSegmentNumbersRef.current.add(segment.segmentNumber);
    realtimeSegmentQueueRef.current.push(segment);
    realtimeSegmentQueueRef.current.sort(
      (left, right) => left.segmentNumber - right.segmentNumber,
    );
    void playNextRealtimeAudioSegment(lifecycleId);
  }

  async function playNextRealtimeAudioSegment(lifecycleId: number): Promise<void> {
    if (lifecycleId !== realtimeLifecycleRef.current) return;
    if (realtimeSegmentPlayerRef.current) return;
    const next = realtimeSegmentQueueRef.current.shift();
    if (!next) {
      if (realtimeSessionIdRef.current) setRealtimeState("listening");
      return;
    }

    const objectUrl = URL.createObjectURL(next.blob);
    const audio = new Audio(objectUrl);
    audio.preload = "auto";
    realtimeSegmentUrlRef.current = objectUrl;
    realtimeSegmentPlayerRef.current = audio;
    setRealtimeState("speaking");

    const cleanup = () => {
      if (realtimeSegmentPlayerRef.current === audio) {
        realtimeSegmentPlayerRef.current = null;
      }
      if (realtimeSegmentUrlRef.current === objectUrl) {
        realtimeSegmentUrlRef.current = "";
        URL.revokeObjectURL(objectUrl);
      }
    };
    audio.onended = () => {
      cleanup();
      void playNextRealtimeAudioSegment(lifecycleId);
    };
    audio.onerror = () => {
      cleanup();
      if (lifecycleId === realtimeLifecycleRef.current) {
        setNotice("Um trecho de áudio não pôde ser reproduzido; continuando a conversa.");
        void playNextRealtimeAudioSegment(lifecycleId);
      }
    };
    try {
      await audio.play();
    } catch (err) {
      cleanup();
      if (lifecycleId !== realtimeLifecycleRef.current) return;
      setNotice("O navegador bloqueou a reprodução automática. Interaja com a página para ouvir a resposta.");
      void playNextRealtimeAudioSegment(lifecycleId);
    }
  }

  async function playCanonicalMessageVoice(
    messageId: string,
    fromRealtime = false,
  ) {
    if (!threadId || threadId !== activeThreadRef.current) return;
    stopMessageAudio();
    const controller = new AbortController();
    messageVoiceAbortRef.current = controller;
    try {
      if (fromRealtime) setRealtimeState("speaking");
      setSpeakingMessageId(messageId);
      const voice = await messageVoice(
        threadId,
        messageId,
        "pt-BR",
        controller.signal,
      );
      if (
        controller.signal.aborted ||
        threadId !== activeThreadRef.current
      ) {
        return;
      }
      const objectUrl = URL.createObjectURL(voice.blob);
      messageAudioUrlRef.current = objectUrl;
      const audio = new Audio(objectUrl);
      messageAudioRef.current = audio;
      audio.onended = () => {
        if (messageAudioRef.current === audio) {
          stopMessageAudio();
          if (fromRealtime && realtimeSessionIdRef.current) {
            setRealtimeState("listening");
          }
        }
      };
      audio.onerror = () => {
        if (messageAudioRef.current === audio) {
          stopMessageAudio();
          setError("O áudio foi gerado, mas o navegador não conseguiu reproduzi-lo.");
          if (fromRealtime && realtimeSessionIdRef.current) {
            setRealtimeState("listening");
          }
        }
      };
      await audio.play();
    } catch (err) {
      if (!controller.signal.aborted) setError(describe(err));
      stopMessageAudio();
      if (fromRealtime && realtimeSessionIdRef.current) {
        setRealtimeState("listening");
      }
    } finally {
      if (messageVoiceAbortRef.current === controller) {
        messageVoiceAbortRef.current = null;
      }
    }
  }

  async function handleMessageVoice(messageId: string) {
    if (!requireProvisioned() || !threadId) return;
    if (speakingMessageId === messageId) {
      stopMessageAudio();
      return;
    }
    await playCanonicalMessageVoice(messageId);
  }

  /**
   * Diagnostic-only monitor. Does not change the provider session, ICE
   * negotiation, audio capture, VAD, canonical agent or turn submission.
   * No SDP, IPs, device IDs, audio or transcripts are ever logged.
   */
  function startRealtimeTransportDiagnostics(
    peer: RTCPeerConnection,
    channel: RTCDataChannel,
    lifecycleId: number,
    sessionThreadId: string,
  ) {
    if (realtimeStatsTimerRef.current !== null) {
      window.clearInterval(realtimeStatsTimerRef.current);
    }
    realtimePreviousPacketsRef.current = null;
    let pending = false;
    const isActive = () =>
      lifecycleId === realtimeLifecycleRef.current &&
      realtimePeerRef.current === peer &&
      realtimeChannelRef.current === channel &&
      activeThreadRef.current === sessionThreadId;

    async function sample() {
      if (!isActive() || pending) return;
      pending = true;
      try {
        const report = summarizeOutboundAudioRtp(await peer.getStats());
        if (!isActive()) return;
        const liveMic = realtimeStreamRef.current
          ?.getAudioTracks()
          .some((track) => track.readyState === "live" && track.enabled);
        const previousPackets = realtimePreviousPacketsRef.current;
        realtimePreviousPacketsRef.current = report.reports ? report.packets : null;
        const rtpDescription = !report.reports
          ? "RTP áudio: relatório ausente"
          : previousPackets === null
            ? `RTP áudio: primeira amostra (${report.packets} pacotes)`
            : report.packets > previousPackets
              ? `RTP áudio: +${report.packets - previousPackets} pacotes/${REALTIME_RTP_SAMPLE_INTERVAL_MS / 1000}s`
              : "RTP áudio: sem avanço de pacotes";
        setRealtimeTransportDiagnostic(
          `Mic: ${liveMic ? "ativo" : "inativo"} · ` +
          `Canal: ${channel.readyState} · ICE: ${peer.iceConnectionState} · ` +
          `Peer: ${peer.connectionState} · ${rtpDescription}`,
        );
      } catch {
        if (isActive()) {
          setRealtimeTransportDiagnostic(
            `Canal: ${channel.readyState} · ICE: ${peer.iceConnectionState} · ` +
            "estatísticas RTP indisponíveis",
          );
        }
      } finally {
        pending = false;
      }
    }
    setRealtimeTransportDiagnostic("Diagnóstico RTP: aguardando primeira amostra…");
    void sample();
    realtimeStatsTimerRef.current = window.setInterval(() => {
      void sample();
    }, REALTIME_RTP_SAMPLE_INTERVAL_MS);
  }

  function stopRealtimeSession() {
    realtimeLifecycleRef.current += 1;
    if (realtimeStatsTimerRef.current !== null) {
      window.clearInterval(realtimeStatsTimerRef.current);
      realtimeStatsTimerRef.current = null;
    }
    realtimePreviousPacketsRef.current = null;
    setRealtimeTransportDiagnostic("");
    if (realtimeConnectionWatchdogRef.current !== null) {
      window.clearTimeout(realtimeConnectionWatchdogRef.current);
      realtimeConnectionWatchdogRef.current = null;
    }
    realtimeOutputAbortRef.current?.abort();
    realtimeOutputAbortRef.current = null;
    stopRealtimeSegmentAudio();
    const channel = realtimeChannelRef.current;
    const peer = realtimePeerRef.current;
    const stream = realtimeStreamRef.current;

    // Invalidate refs before closing resources: close() may synchronously invoke
    // onclose/onconnectionstatechange and must not re-enter a half-cleaned session.
    realtimeChannelRef.current = null;
    realtimePeerRef.current = null;
    realtimeStreamRef.current = null;
    realtimeSessionIdRef.current = "";
    realtimeSessionThreadRef.current = "";
    realtimeSeenFinalIdsRef.current.clear();
    realtimeSeenSegmentNumbersRef.current.clear();
    realtimeTurnChainRef.current = Promise.resolve();
    setRealtimePartialTranscript("");
    setRealtimeState("idle");

    try {
      channel?.close();
    } catch (err) {
      console.warn("PatroAI Realtime channel cleanup failed", err);
    }
    try {
      peer?.close();
    } catch (err) {
      console.warn("PatroAI Realtime peer cleanup failed", err);
    }
    try {
      stream?.getTracks().forEach((track) => track.stop());
    } catch (err) {
      console.warn("PatroAI Realtime media cleanup failed", err);
    }
  }

  function waitForIceGatheringComplete(
    peer: RTCPeerConnection,
    timeoutMs = 3000,
  ): Promise<void> {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = window.setTimeout(done, timeoutMs);
      function done() {
        window.clearTimeout(timeout);
        peer.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      }
      function onChange() {
        if (peer.iceGatheringState === "complete") done();
      }
      peer.addEventListener("icegatheringstatechange", onChange);
    });
  }

  async function processRealtimeFinal(
    eventId: string,
    itemId: string,
    transcript: string,
    sessionId: string,
    sessionThreadId: string,
    lifecycleId: number,
  ) {
    const isCurrentSession = () =>
      lifecycleId === realtimeLifecycleRef.current &&
      sessionId === realtimeSessionIdRef.current &&
      sessionThreadId === activeThreadRef.current;

    if (
      !sessionId ||
      !eventId ||
      !itemId ||
      !transcript.trim() ||
      !isCurrentSession()
    ) {
      return;
    }
    setRealtimeState("executing");
    const outputController = new AbortController();
    realtimeOutputAbortRef.current = outputController;
    try {
      try {
        const output = await streamRealtimeTurn(
          sessionThreadId,
          {
            session_id: sessionId,
            provider_item_id: itemId,
            transcript_final_id: eventId,
            transcript,
            locale: "pt-BR",
          },
          {
            onTextDelta: (text) => {
              if (isCurrentSession()) setStreamingText((current) => current + text);
            },
            onAudioSegment: (segment) => {
              if (!isCurrentSession()) return;
              enqueueRealtimeAudioSegment(
                {
                  blob: segment.blob,
                  codec: segment.codec,
                  segmentNumber: segment.segmentNumber,
                },
                lifecycleId,
              );
            },
          },
          outputController.signal,
        );
        if (!isCurrentSession() || output.status === "aborted") return;
        if (output.status !== "completed") {
          throw new ApiError(0, output.errorCode || "REALTIME_STREAM_TERMINATED");
        }
        setStreamingText("");
        await refreshMessages();
        if (!isCurrentSession()) return;
      } catch (err) {
        if (!isRealtimeStreamUnavailable(err)) throw err;

        // The backend may be one release behind the frontend. Fall back to the
        // proven full-turn contract without starting a second turn after a
        // partially accepted stream response.
        stopRealtimeSegmentAudio();
        setStreamingText("");
        const result = await commitRealtimeTurn(sessionThreadId, {
          session_id: sessionId,
          provider_item_id: itemId,
          transcript_final_id: eventId,
          transcript,
        });
        if (!isCurrentSession()) return;
        const voicePromise = playCanonicalMessageVoice(result.message_id, true);
        const messagesPromise = refreshMessages();
        await Promise.all([voicePromise, messagesPromise]);
        if (!isCurrentSession()) return;
      }
    } catch (err) {
      if (!isCurrentSession() || isAbortLike(err)) return;
      setRealtimeState("error");
      setError(describe(err));
      if (!(err instanceof ApiError)) {
        reportUnexpectedRuntimeError(err, "Realtime turn processing");
      }
    } finally {
      if (realtimeOutputAbortRef.current === outputController) {
        realtimeOutputAbortRef.current = null;
      }
    }
  }

  function handleRealtimeProviderEvent(raw: unknown) {
    if (!raw || typeof raw !== "object") return;
    const event = raw as Record<string, unknown>;
    const eventType = String(event.type || "");
    if (eventType === "input_audio_buffer.speech_started") {
      setRealtimeState("interrupted");
      setNotice("Fala detectada pelo provedor; aguardando fim do turno.");
      stopRealtimeSegmentAudio();
      setRealtimePartialTranscript("");
      return;
    }
    if (eventType === "input_audio_buffer.speech_stopped") {
      setRealtimeState("transcribing");
      setNotice("Fim da fala detectado; aguardando transcrição.");
      return;
    }
    if (eventType === "conversation.item.input_audio_transcription.delta") {
      const delta = String(event.delta || "");
      if (delta) {
        setRealtimePartialTranscript((current) => current + delta);
        setRealtimeState("transcribing");
      }
      return;
    }
    if (eventType === "conversation.item.input_audio_transcription.failed") {
      setRealtimeState("error");
      setError("O serviço de voz não conseguiu transcrever a fala. Encerre e tente novamente.");
      return;
    }
    if (eventType === "error") {
      setRealtimeState("error");
      setError("O provedor Realtime comunicou uma falha. Encerre e tente novamente.");
      return;
    }
    if (eventType !== "conversation.item.input_audio_transcription.completed") {
      return;
    }
    const eventId = String(event.event_id || "");
    const itemId = String(event.item_id || "");
    const transcript = String(event.transcript || "").trim();
    if (!eventId || !itemId || !transcript) return;

    setNotice("Transcrição final recebida; encaminhando o turno ao agente.");
    const dedupeId = `${itemId}:${eventId}`;
    if (realtimeSeenFinalIdsRef.current.has(dedupeId)) return;
    realtimeSeenFinalIdsRef.current.add(dedupeId);
    setRealtimePartialTranscript("");

    const sessionId = realtimeSessionIdRef.current;
    const sessionThreadId = realtimeSessionThreadRef.current;
    const lifecycleId = realtimeLifecycleRef.current;
    setRealtimeState("transcribing");
    realtimeTurnChainRef.current = realtimeTurnChainRef.current
      .then(() =>
        processRealtimeFinal(
          eventId,
          itemId,
          transcript,
          sessionId,
          sessionThreadId,
          lifecycleId,
        ),
      )
      .catch((err) => {
        if (!isAbortLike(err)) {
          reportUnexpectedRuntimeError(err, "Realtime turn queue");
        }
      });
  }

  async function startRealtimeSession() {
    if (!requireProvisioned()) return;
    if (!threadId) {
      setError("Crie ou selecione uma conversa antes de iniciar o Realtime.");
      return;
    }
    if (executionMode !== "individual") {
      setError("Realtime de agente requer modo Individual. No modo Pessoas não há execução de IA.");
      return;
    }
    if (!selectedTechnicalTarget) {
      setError("Selecione um agente disponível antes de iniciar o Realtime.");
      return;
    }
    if (!realtimeReady) {
      setShowRealtimeInfo(true);
      void refreshRealtimeCapabilities();
      return;
    }
    if (
      typeof RTCPeerConnection === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      setError("Este navegador não oferece WebRTC/microfone compatível.");
      return;
    }

    const sessionThreadId = threadId;
    cancelVoiceCapture(true);
    stopMessageAudio();
    stopRealtimeSession();
    const lifecycleId = realtimeLifecycleRef.current;
    const isCurrentAttempt = () =>
      lifecycleId === realtimeLifecycleRef.current &&
      sessionThreadId === activeThreadRef.current;
    setError("");
    setNotice("");
    setRealtimeState("requesting_microphone");

    const peer = new RTCPeerConnection();
    realtimePeerRef.current = peer;
    const channel = peer.createDataChannel("oai-events");
    realtimeChannelRef.current = channel;

    channel.onmessage = (event) => {
      if (!isCurrentAttempt() || realtimeChannelRef.current !== channel) return;
      try {
        handleRealtimeProviderEvent(JSON.parse(String(event.data || "{}")));
      } catch (err) {
        // Eventos não JSON ou desconhecidos não ganham autoridade no runtime.
        reportUnexpectedRuntimeError(err, "Realtime provider event");
      }
    };
    channel.onopen = () => {
      if (isCurrentAttempt() && realtimeChannelRef.current === channel) {
        if (realtimeConnectionWatchdogRef.current !== null) {
          window.clearTimeout(realtimeConnectionWatchdogRef.current);
          realtimeConnectionWatchdogRef.current = null;
        }
        setRealtimeState("listening");
        setNotice("Canal de dados Realtime aberto. Aguardando sua fala.");
      }
    };
    channel.onerror = () => {
      if (isCurrentAttempt() && realtimeChannelRef.current === channel) {
        stopRealtimeSession();
        setRealtimeState("error");
        setError("O canal de dados do Realtime falhou. A chamada não está ouvindo.");
      }
    };
    channel.onclose = () => {
      if (
        isCurrentAttempt() &&
        realtimeChannelRef.current === channel &&
        realtimeSessionIdRef.current
      ) {
        stopRealtimeSession();
        setRealtimeState("error");
        setError("O canal de dados do Realtime foi encerrado.");
      }
    };

    peer.onconnectionstatechange = () => {
      if (
        isCurrentAttempt() &&
        realtimePeerRef.current === peer &&
        ["failed", "closed"].includes(peer.connectionState)
      ) {
        stopRealtimeSession();
        setRealtimeState("error");
        setError("A conexão WebRTC falhou ou foi encerrada.");
      }
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(VOICE_INPUT_CONSTRAINTS);
      if (!isCurrentAttempt()) {
        stream.getTracks().forEach((track) => track.stop());
        try {
          peer.close();
        } catch {
          // A stale peer is already being torn down; no user-facing error is needed.
        }
        return;
      }
      realtimeStreamRef.current = stream;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGatheringComplete(peer);
      const sdp = peer.localDescription?.sdp || offer.sdp || "";
      if (!sdp) throw new ApiError(0, "REALTIME_SDP_EMPTY");

      const call = await createRealtimeCall(sessionThreadId, {
        sdp,
        target_mode: "direct",
        agent: selectedTechnicalTarget,
        locale: "pt-BR",
      });

      if (!isCurrentAttempt()) {
        try {
          peer.close();
        } catch {
          // The attempt was invalidated while the offer was in flight.
        }
        return;
      }
      realtimeSessionIdRef.current = call.session_id;
      realtimeSessionThreadRef.current = sessionThreadId;
      await peer.setRemoteDescription({ type: "answer", sdp: call.sdp });
      if (!isCurrentAttempt()) return;
      startRealtimeTransportDiagnostics(peer, channel, lifecycleId, sessionThreadId);
      // SDP accepted is not proof of a working data channel. "Ouvindo" only
      // becomes true after channel.onopen, not after an HTTP 200 response.
      if (channel.readyState === "open") {
        setRealtimeState("listening");
        setNotice(`Realtime conectado com ${call.agent_name}.`);
      } else {
        setRealtimeState("connecting");
        setNotice(`Aguardando conexão de áudio com ${call.agent_name}...`);
        realtimeConnectionWatchdogRef.current = window.setTimeout(() => {
          realtimeConnectionWatchdogRef.current = null;
          if (
            !isCurrentAttempt() ||
            realtimeChannelRef.current !== channel ||
            channel.readyState === "open"
          ) return;
          stopRealtimeSession();
          setRealtimeState("error");
          setError("O canal de dados Realtime não abriu em 15 segundos. A fala não está sendo processada.");
        }, 15000);
      }
    } catch (err) {
      const name =
        err && typeof err === "object" && "name" in err
          ? String((err as { name?: unknown }).name || "")
          : "";
      if (!isCurrentAttempt() || isAbortLike(err)) return;
      stopRealtimeSession();
      setRealtimeState("error");
      setError(
        name === "NotAllowedError"
          ? "Permissão do microfone negada para o Realtime."
          : describe(err),
      );
      if (name !== "NotAllowedError" && !(err instanceof ApiError)) {
        reportUnexpectedRuntimeError(err, "Realtime session start");
      }
    }
  }

  function handleRealtimeButton() {
    if (realtimeState !== "idle" && realtimeState !== "error") {
      stopRealtimeSession();
      setNotice("Realtime encerrado.");
      return;
    }
    if (!realtimeReady) {
      setShowRealtimeInfo(true);
      void refreshRealtimeCapabilities();
      return;
    }
    void startRealtimeSession();
  }

  const documentIntake = useDocumentIntake(threadId || null);

  function handleComposerPaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText && documentIntake.interceptPaste(pastedText)) event.preventDefault();
  }

  async function handleNewThread() {
    if (!requireProvisioned()) return;
    if (!configured) {
      setError(describe("API_BASE_URL_NOT_CONFIGURED"));
      return;
    }
    setError("");
    try {
      const created = await createThread();
      await refreshThreads();
      selectThread(created.id);
      setNotice("Conversa criada.");
    } catch (err) {
      setError(describe(err));
    }
  }

  async function handleSend() {
    const content = message.trim();
    if (
      !content ||
      sending ||
      voiceState === "recording" ||
      voiceState === "transcribing"
    )
      return;
    if (!requireProvisioned()) return;
    if (!threadId) {
      setError("Crie ou selecione uma conversa antes de enviar.");
      return;
    }
    if (executionMode === "individual" && !selectedTechnicalTarget) {
      setError("Selecione um agente disponível antes de enviar.");
      return;
    }

    const currentThread = threads.find((thread) => thread.id === threadId);
    if (currentThread && (!currentThread.title || currentThread.title === "Nova conversa")) {
      const autoTitle = deriveThreadTitle(content);
      try {
        const renamed = await updateThreadTitle(threadId, autoTitle);
        setThreads((current) =>
          current.map((thread) =>
            thread.id === renamed.id ? { ...thread, title: renamed.title } : thread,
          ),
        );
      } catch {
        // O título não pode impedir a execução da mensagem.
      }
    }

    let teamDefinition: TeamDefinition | null = null;
    let teamContributorIds: string[] = [];
    if (executionMode === "team") {
      teamDefinition =
        teams.find((team) => team.team_id === selectedTeamId) ?? null;
      if (!teamDefinition) {
        setError("Nenhum Team governado está disponível.");
        return;
      }
      teamContributorIds = Array.from(new Set(teamParticipants)).filter(
        (id) =>
          id !== teamDefinition?.orchestrator_agent_id &&
          teamDefinition?.candidate_contributor_agent_ids.includes(id),
      );
      if (
        teamSelectionMode === "explicit" &&
        teamContributorIds.length <
          teamDefinition.participant_policy.min_contributors
      ) {
        setError(describe(new ApiError(0, "TEAM_MIN_CONTRIBUTORS_REQUIRED")));
        return;
      }
      if (
        teamSelectionMode === "explicit" &&
        teamContributorIds.length >
          teamDefinition.participant_policy.max_contributors
      ) {
        setError(describe(new ApiError(0, "TEAM_MAX_CONTRIBUTORS_EXCEEDED")));
        return;
      }
      if (
        teamSelectionMode === "all_eligible" &&
        !teamDefinition.participant_policy.select_all_supported
      ) {
        setError(describe(new ApiError(0, "TEAM_SELECT_ALL_NOT_SUPPORTED")));
        return;
      }
    }

    followLatestRef.current = true;
    setError("");
    setNotice("");
    setSending(true);
    setStreamingText("");
    const optimistic: ChatMessage = {
      id: `local-${Date.now()}`,
      author_type: "user",
      author_id: me?.user_id || null,
      user_id: me?.user_id || null,
      author_display_name: me?.display_name?.trim() || null,
      agent_name: null,
      content,
      created_at: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    setMessage("");
    if (voiceState === "review") {
      voiceTranscriptOwnedRef.current = false;
      setVoiceState("idle");
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const commonHandlers = {
        onChunk: (text: string) =>
          setStreamingText((current) => current + text),
        onError: (code: string) =>
          setError(describe(new ApiError(0, code))),
        onDone: (data: Record<string, unknown>) => {
          const artifact = parseArtifactMetadata(data);
          if (data.artifact !== undefined && !artifact) {
            setError(describe(new ApiError(0, "ARTIFACT_METADATA_INVALID")));
          }
          if (artifact) {
            setArtifacts((current) => [
              ...current.filter(
                (item) => item.artifact_id !== artifact.artifact_id,
              ),
              artifact,
            ]);
          }
          const artifactErrorCode =
            typeof data.artifact_error === "string" ? data.artifact_error : "";
          if (artifactErrorCode) {
            setNotice(
              `Resposta concluída, mas o arquivo não ficou disponível (${artifactErrorCode}).`,
            );
          }
          setTeamRunStatus("");
          setStreamingText("");
          void refreshMessages();
        },
      };

      if (executionMode === "human") {
        await postHumanMessage(threadId, content);
        await refreshMessages();
      } else if (executionMode === "team" && teamDefinition) {
        setTeamRunStatus("Team iniciando…");
        await streamTeamMessage(
          threadId,
          content,
          {
            team_id: teamDefinition.team_id,
            selection_mode: teamSelectionMode,
            contributor_agent_ids:
              teamSelectionMode === "explicit" ? teamContributorIds : undefined,
          },
          {
            ...commonHandlers,
            onStatus: (data) => {
              const status = String(data.status ?? "");
              if (status === "team_synthesizing") {
                setTeamRunStatus("Plataforma consolidando as contribuições…");
              } else if (status === "team_started") {
                setTeamRunStatus("Team em colaboração…");
              }
            },
            onAgentStarted: (data) =>
              setTeamRunStatus(`${String(data.agent_name ?? data.agent_id ?? "Especialista")} analisando…`),
            onAgentDone: (data) => {
              const name = String(data.agent_name ?? data.agent_id ?? "Especialista");
              const status = String(data.status ?? "");
              setTeamRunStatus(
                status === "completed"
                  ? `${name} concluiu.`
                  : `${name} não concluiu; o Team seguirá com as demais contribuições.`,
              );
            },
          },
          controller.signal,
        );
      } else {
        if (!selectedTechnicalTarget) {
          throw new ApiError(0, "AGENT_NOT_FOUND");
        }
        await streamMessage(
          threadId,
          content,
          selectedTechnicalTarget,
          commonHandlers,
          controller.signal,
        );
      }
    } catch (err) {
      setError(describe(err));
    } finally {
      abortRef.current = null;
      setSending(false);
      setTeamRunStatus("");
      setStreamingText("");
    }
  }

  async function handleArtifactDownload(artifact: ArtifactMetadata) {
    if (!requireProvisioned()) return;
    setArtifactDownloadBusy(artifact.artifact_id);
    setArtifactDownloadErrors((current) => ({
      ...current,
      [artifact.artifact_id]: "",
    }));
    try {
      await downloadArtifact(artifact);
      setNotice(`Download iniciado: ${artifact.filename}`);
    } catch (err) {
      setArtifactDownloadErrors((current) => ({
        ...current,
        [artifact.artifact_id]: describe(err),
      }));
    } finally {
      setArtifactDownloadBusy("");
    }
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!requireProvisioned()) return;
    if (!threadPermissions?.can_upload_files) {
      setError("Você não tem permissão para anexar documentos nesta conversa.");
      return;
    }
    if (!threadId) {
      setError("Crie ou selecione uma conversa antes de anexar.");
      return;
    }

    const fileCapabilities = documentIntake.fileCapabilities;
    if (
      fileCapabilities?.supported &&
      file.size > fileCapabilities.max_bytes
    ) {
      setError(
        `O arquivo excede o limite máximo de ${(fileCapabilities.max_bytes / (1024 * 1024)).toFixed(0)} MB para documentos grandes.`,
      );
      return;
    }
    if (
      fileCapabilities?.supported &&
      file.size > fileCapabilities.threshold_bytes &&
      !fileCapabilities.enabled
    ) {
      setError(
        "Processamento de arquivo grande não está habilitado neste ambiente.",
      );
      return;
    }

    const useLargeIntake = Boolean(
      fileCapabilities?.supported &&
        fileCapabilities.enabled &&
        file.size > fileCapabilities.threshold_bytes,
    );

    setError("");
    setNotice(
      useLargeIntake
        ? `Preparando documento grande: ${file.name}`
        : `Preparando anexo: ${file.name}`,
    );
    setUploading(true);
    try {
      const uploaded = useLargeIntake
        ? await uploadLargeDocumentIntake(threadId, file).then((result) => ({
            id: result.attachment_id,
            filename: result.filename,
            sha256: result.canonical_sha256,
            reused: result.reused,
          }))
        : await uploadAttachment(threadId, file).then((result) => ({
            ...result,
            reused: false,
          }));
      setRecentAttachment(uploaded.filename);
      setNotice(
        useLargeIntake
          ? `Documento grande processado: ${uploaded.filename} · validando contexto seletivo…`
          : `Anexo enviado: ${uploaded.filename} · processando contexto…`,
      );
      try {
        const provenance = await getDocumentContextProvenance(threadId);
        const uploadedSource = provenance.source_provenance.find(
          (source) => source.attachment_id === uploaded.id,
        );
        if (uploadedSource?.extraction_status === "ready") {
          const detail = uploadedSource.truncated
            ? `${uploadedSource.provided_chars.toLocaleString("pt-BR")} de ${uploadedSource.source_chars.toLocaleString("pt-BR")} caracteres fornecidos`
            : `${uploadedSource.provided_chars.toLocaleString("pt-BR")} caracteres processados`;
          setDocumentProvenanceLabel(`✓ Documento lido · ${detail}`);
          setNotice(
            useLargeIntake
              ? `Documento grande disponível no contexto: ${uploaded.filename}`
              : `Documento lido: ${uploaded.filename}`,
          );
        } else if (provenance.source_ids.includes(uploaded.id)) {
          setDocumentProvenanceLabel(
            "Documento processado · provenance individual indisponível.",
          );
          setNotice(`Anexo processado: ${uploaded.filename}`);
        } else if (
          provenance.extraction_status === "failed" &&
          provenance.sources === 0
        ) {
          setDocumentProvenanceLabel("Falha de extração do documento.");
          setNotice("Anexo armazenado, mas o conteúdo não pôde ser extraído.");
        } else {
          setDocumentProvenanceLabel(
            "Documento armazenado · este arquivo ainda não está disponível no contexto.",
          );
          setNotice(
            `Anexo armazenado: ${uploaded.filename} · contexto deste arquivo não confirmado.`,
          );
        }
      } catch (provenanceError) {
        // The upload is already committed. Do not present a secondary context
        // lookup failure as if the user lost the file.
        console.warn("DOCUMENT_CONTEXT_STATUS_UNAVAILABLE", {
          code: describe(provenanceError),
          threadId,
          attachmentId: uploaded.id,
        });
        setDocumentProvenanceLabel(
          "Anexo armazenado · leitura do contexto pendente.",
        );
        setNotice(
          `Anexo armazenado: ${uploaded.filename} · contexto será atualizado depois.`,
        );
      }
    } catch (err) {
      setError(describe(err));
    } finally {
      setUploading(false);
    }
  }

  async function refreshParticipants() {
    if (!threadId) return;
    setParticipantsBusy(true);
    setParticipantError("");
    try {
      const rows = await listThreadParticipants(threadId);
      setParticipants(rows);
      setParticipantAccessHours((current) => Object.fromEntries(
        rows.map((item) => [item.user_id, current[item.user_id] ?? "72"]),
      ));
      setParticipantDrafts(Object.fromEntries(
        rows.map((item) => [item.user_id, {
          history_access: item.history_access ?? "from_join",
          allowed_agent_ids: item.allowed_agent_ids?.length ? item.allowed_agent_ids : ["orkio"],
          can_upload_files: Boolean(item.can_upload_files),
          can_read_messages: item.can_read_messages !== false,
          can_write_messages: item.can_write_messages !== false,
          can_view_attachments: Boolean(item.can_view_attachments),
          can_download_artifacts: Boolean(item.can_download_artifacts),
          can_generate_artifacts: Boolean(item.can_generate_artifacts),
        }]),
      ));
    } catch (err) {
      setParticipantError(describe(err));
    } finally {
      setParticipantsBusy(false);
    }
  }

  async function saveParticipant(userId: string) {
    const draft = participantDrafts[userId];
    if (!threadId || !draft || participantAction) return;
    setParticipantAction(userId);
    setParticipantError("");
    try {
      await updateThreadParticipantPermissions(threadId, userId, draft);
      await refreshParticipants();
      setNotice("Permissões do colaborador atualizadas.");
    } catch (err) {
      setParticipantError(describe(err));
    } finally {
      setParticipantAction("");
    }
  }

  async function renewParticipantAccess(userId: string) {
    const rawHours = participantAccessHours[userId] ?? "72";
    const hours = rawHours === "" ? null : Number(rawHours);
    if (!threadId || participantAction ||
        (hours !== null && (!Number.isInteger(hours) || hours < 1 || hours > 8760))) {
      setParticipantError("Escolha um prazo de 1 a 8760 horas ou sem prazo.");
      return;
    }
    if (!window.confirm(
      hours === null
        ? "Permitir acesso sem data de vencimento para esta pessoa?"
        : `Alterar a validade do acesso para ${hours} hora(s) a partir de agora?`,
    )) return;
    setParticipantAction(userId);
    setParticipantError("");
    try {
      await updateThreadParticipantAccess(threadId, userId, hours);
      await refreshParticipants();
      setNotice("Prazo de acesso do participante atualizado.");
    } catch (err) {
      setParticipantError(describe(err));
    } finally {
      setParticipantAction("");
    }
  }

  async function removeParticipant(userId: string) {
    if (!threadId || participantAction) return;
    if (!window.confirm("Revogar o acesso desta pessoa à conversa?")) return;
    setParticipantAction(userId);
    setParticipantError("");
    try {
      await revokeThreadParticipant(threadId, userId);
      await refreshParticipants();
      setNotice("Vínculo revogado.");
    } catch (err) {
      setParticipantError(describe(err));
    } finally {
      setParticipantAction("");
    }
  }

  async function invite() {
    if (!requireProvisioned()) {
      setInviteError(
        authenticated
          ? "Ative sua conta na organização PatroAI antes de convidar participantes."
          : "Autentique-se para convidar participantes.",
      );
      return;
    }
    if (!threadId) {
      setInviteError("Crie ou selecione uma conversa antes de convidar.");
      return;
    }
    setInviteError("");
    setInviteUrl("");
    setInviteDeliveryStatus("");
    setInviteBusy(true);
    try {
      const out = await createInvite(threadId, {
        email,
        role: "participant",
        history_access: inviteHistory,
        allowed_agent_ids: [inviteAgentId],
        can_upload_files: inviteCanUpload,
        can_read_messages: inviteCanRead,
        can_write_messages: inviteCanWrite,
        can_view_attachments: inviteCanViewDocuments,
        can_download_artifacts: inviteCanDownloadArtifacts,
        can_generate_artifacts: inviteCanGenerateArtifacts,
        access_duration_hours: inviteUnlimitedAccess ? null : Number(inviteAccessHours),
      });
      setInviteUrl(out.invitation_url);
      setInviteDeliveryStatus("link_only");
      setEmail("");
    } catch (err) {
      setInviteError(describe(err));
    } finally {
      setInviteBusy(false);
    }
  }

  async function saveCoCreatorName() {
    const clean = renameCoCreatorValue.trim();
    if (clean.length < 2 || renameCoCreatorBusy) return;
    if (!requireProvisioned()) return;
    setRenameCoCreatorBusy(true);
    setError("");
    try {
      const result = await updateCoCreatorName(clean);
      setMe((current) =>
        current
          ? { ...current, co_creator_name: result.co_creator_name }
          : current,
      );
      setShowRenameCoCreator(false);
      setNotice(`Seu Co-Criador agora se chama ${result.co_creator_name}.`);
    } catch (err) {
      setError(describe(err));
    } finally {
      setRenameCoCreatorBusy(false);
    }
  }

  async function saveThreadTitle() {
    const clean = renameThreadValue.trim();
    if (!threadId || clean.length < 1 || renameThreadBusy) return;
    if (!requireProvisioned()) return;
    setRenameThreadBusy(true);
    setError("");
    try {
      const result = await updateThreadTitle(threadId, clean);
      setThreads((current) =>
        current.map((thread) =>
          thread.id === result.id ? { ...thread, title: result.title } : thread,
        ),
      );
      setShowRenameThread(false);
      setNotice("Nome da conversa atualizado.");
    } catch (err) {
      setError(describe(err));
    } finally {
      setRenameThreadBusy(false);
    }
  }

  const activeThread = threads.find((thread) => thread.id === threadId) ?? null;
  const selectedAgentName =
    selectedAgent?.display_name || me?.co_creator_name || DEFAULT_COCREATOR_LABEL;
  const visibleAgentAuthor = (itemAgentName?: string | null) =>
    itemAgentName?.trim() || "Agente";
  const visibleHumanAuthor = (item: ChatMessage) => {
    const canonicalName = item.author_display_name?.trim();
    if (canonicalName) return canonicalName;
    const authorId = item.author_id || item.user_id;
    if (authorId && me?.user_id && authorId === me.user_id) {
      return me.display_name?.trim() || me.co_creator_name?.trim() || "Você";
    }
    return "Participante";
  };
  const selectedAgentRole =
    selectedAgent?.role_label || "Agente disponível";
  const selectedAgentInitial = selectedAgentName.slice(0, 1).toUpperCase();
  const activeTeam = teams.find((team) => team.team_id === selectedTeamId) ?? null;
  const teamMin = activeTeam?.participant_policy.min_contributors ?? 2;
  const teamMax = activeTeam?.participant_policy.max_contributors ?? 0;
  const teamEligibleCount = activeTeam?.participant_policy.eligible_count ?? 0;
  const executionTargetName =
    executionMode === "human" ? "Pessoas · sem IA" : selectedAgent?.display_name || "Selecionar agente";
  const executionTargetRole =
    executionMode === "human" ? "Conversa entre participantes" : selectedAgent?.role_label || "Seleção explícita necessária";
  const realtimeReason =
    (!realtimeCapabilities?.realtime_session?.eligible &&
      realtimeCapabilities?.realtime_session?.reason_code) ||
    (!realtimeCapabilities?.orchestration_bridge?.eligible &&
      realtimeCapabilities?.orchestration_bridge?.reason_code) ||
    (!realtimeCapabilities?.voice_input?.eligible &&
      realtimeCapabilities?.voice_input?.reason_code) ||
    (!realtimeCapabilities?.voice_output?.eligible &&
      realtimeCapabilities?.voice_output?.reason_code) ||
    "REALTIME_CAPABILITY_NOT_PROVEN";
  const realtimeReady = Boolean(
    realtimeCapabilities?.realtime_session?.eligible &&
      realtimeCapabilities?.orchestration_bridge?.eligible &&
      realtimeCapabilities?.voice_input?.eligible &&
      realtimeCapabilities?.voice_output?.eligible,
  );
  const realtimeActive =
    realtimeState !== "idle" && realtimeState !== "error";
  const realtimeStateLabel: Record<RealtimeState, string> = {
    idle: realtimeReady ? "Pronto" : "Em preparação",
    requesting_microphone: "Solicitando microfone",
    connecting: "Conectando",
    connected: "Conectado",
    listening: "Ouvindo",
    transcribing: "Transcrevendo",
    executing: "Executando com agente canônico",
    speaking: "Falando",
    interrupted: "Interrompido",
    disconnecting: "Encerrando",
    unavailable: "Indisponível",
    error: "Erro",
  };

  function selectTeamDefinition(teamId: string) {
    const definition = teams.find((team) => team.team_id === teamId);
    if (!definition) return;
    setSelectedTeamId(teamId);
    setTeamSelectionMode("explicit");
    const candidates = definition.candidate_contributor_agent_ids;
    const preferred =
      selectedAgent && candidates.includes(selectedAgent.slug)
        ? selectedAgent.slug
        : candidates[0];
    const next = preferred ? [preferred] : [];
    for (const candidate of candidates) {
      if (next.length >= definition.participant_policy.min_contributors) break;
      if (!next.includes(candidate)) next.push(candidate);
    }
    setTeamParticipants(
      next.slice(0, definition.participant_policy.max_contributors),
    );
  }

  function toggleTeamParticipant(agentId: string) {
    const definition = activeTeam;
    if (!definition) return;
    if (agentId === definition.orchestrator_agent_id) return;
    if (!definition.candidate_contributor_agent_ids.includes(agentId)) return;
    setTeamSelectionMode("explicit");
    setTeamParticipants((current) => {
      if (current.includes(agentId)) {
        return current.filter((id) => id !== agentId);
      }
      const max = definition.participant_policy.max_contributors;
      if (current.length >= max) {
        setNotice(`O Team aceita no máximo ${max} especialistas nesta versão.`);
        return current;
      }
      return [...current, agentId];
    });
  }

  function selectAllTeamContributors() {
    if (!activeTeam) return;
    if (!activeTeam.participant_policy.select_all_supported) {
      setNotice(
        `${activeTeam.participant_policy.eligible_count} especialistas elegíveis · limite operacional ${activeTeam.participant_policy.max_contributors}. "Selecionar todos" será liberado pelo backend após prova de carga.`,
      );
      return;
    }
    setTeamSelectionMode("all_eligible");
    setTeamParticipants([...activeTeam.candidate_contributor_agent_ids]);
    setNotice("Todos os especialistas elegíveis foram selecionados pelo contrato do backend.");
  }

  function clearTeamContributors() {
    setTeamSelectionMode("explicit");
    setTeamParticipants([]);
  }

  return (
    <LegacyConversationAdapter>
      <div className="console-shell">
      <aside
        className={showMobileSidebar ? "console-sidebar console-sidebar--open" : "console-sidebar"}
        aria-label="Navegação do console"
      >
        <div className="console-sidebar__brand">
          <Link className="brand-lockup brand-lockup--compact" to="/">
            <span className="brand-orb" aria-hidden="true" />
            <span>Plataforma</span>
          </Link>
          <button
            type="button"
            className="sidebar-close"
            onClick={() => setShowMobileSidebar(false)}
            aria-label="Fechar conversas"
          >
            ×
          </button>
        </div>
        <button
          type="button"
          className="primary-button"
          onClick={handleNewThread}
              disabled={!accountReady || !configured}
        >
          + Nova conversa
        </button>
        <nav className="conversation-nav" aria-label="Conversas">
          <div className="conversation-nav__heading">
            <strong>Conversas</strong>
            <span>{threads.length}</span>
          </div>
          {threads.length === 0 ? (
            <span>Nenhuma conversa selecionada</span>
          ) : (
            <ul className="conversation-list">
              {threads.map((thread) => (
                <li key={thread.id} className="conversation-item-row">
                  <button
                    type="button"
                    className={
                      thread.id === threadId
                        ? "conversation-item conversation-item--active"
                        : "conversation-item"
                    }
                    aria-current={thread.id === threadId ? "true" : undefined}
                    onClick={() => selectThread(thread.id)}
                  >
                    <span className="conversation-item__title">
                      {thread.title || "Nova conversa"}
                    </span>
                    <time
                      className="conversation-item__time"
                      dateTime={thread.created_at}
                      title={formatDateTimeTitle(thread.created_at)}
                    >
                      {formatConversationTimestamp(thread.created_at)}
                    </time>
                  </button>
                  <button
                    type="button"
                    className="conversation-item__rename"
                    aria-label={`Renomear conversa: ${thread.title || "Nova conversa"}`}
                    title="Renomear conversa"
                    onClick={() => {
                      selectThread(thread.id);
                      setRenameThreadValue(thread.title || "Nova conversa");
                      setShowRenameThread(true);
                    }}
                    disabled={!accountReady}
                  >
                    ✎
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <PwaInstallButton compact />
      </aside>
      {showMobileSidebar ? (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Fechar conversas"
          onClick={() => setShowMobileSidebar(false)}
        />
      ) : null}

      <main id="main-content" className="console-main">
        <header className="console-header">
          <div className="console-header__context">
            <button
              type="button"
              className="sidebar-toggle"
              onClick={() => setShowMobileSidebar(true)}
              aria-label="Abrir conversas"
              aria-expanded={showMobileSidebar}
            >
              ☰
            </button>
            <div className="console-header__title">
              <span className="console-header__eyebrow">Conversa ativa</span>
              <div className="console-header__title-row">
                <b>{activeThread?.title || "PatroAI Command Center"}</b>
                {activeThread ? (
                  <button
                    type="button"
                    className="console-header__rename"
                    aria-label="Renomear conversa ativa"
                    title="Renomear conversa"
                    onClick={() => {
                      setRenameThreadValue(activeThread.title || "Nova conversa");
                      setShowRenameThread(true);
                    }}
                    disabled={!accountReady}
                  >
                    ✎
                  </button>
                ) : null}
              </div>
              <small>
                {activeThread
                  ? formatDateTimeTitle(activeThread.created_at)
                  : "Collaborative Intelligence"}
              </small>
            </div>
          </div>
          <div className="console-header__actions">
            <button
              type="button"
              className="active-agent-chip"
              onClick={() => {
                setRenameCoCreatorValue(selectedAgentName);
                setShowRenameCoCreator(true);
              }}
              disabled={!accountReady}
              aria-label={`Co-Criador ativo: ${selectedAgentName}`}
              title="Renomear Co-Criador"
            >
              <span className="active-agent-chip__avatar" aria-hidden="true">
                {selectedAgentInitial}
              </span>
              <span className="active-agent-chip__copy">
                <strong>{selectedAgentName}</strong>
                <small>{selectedAgentRole}</small>
              </span>
            </button>
            <button
              type="button"
              className={`realtime-button realtime-button--${realtimeState} ${
                realtimeReady ? "realtime-button--ready" : "realtime-button--pending"
              }`}
              onClick={handleRealtimeButton}
              aria-pressed={realtimeActive}
              title={
                realtimeReady
                  ? realtimeActive
                    ? "Encerrar Realtime"
                    : "Iniciar Realtime canônico"
                  : "Ver requisitos para liberar o Realtime"
              }
            >
              <span className="realtime-button__pulse" aria-hidden="true" />
              <span className="realtime-button__icon" aria-hidden="true">◉</span>
              <span className="realtime-button__copy">
                <strong>Realtime</strong>
                <small>
                  {realtimeBusy ? "Verificando…" : realtimeStateLabel[realtimeState]}
                </small>
              </span>
            </button>
            <Link className="ghost-link" to="/">
              Início
            </Link>
            <button
              type="button"
              className="ghost-link console-top-link"
              onClick={scrollConversationToTop}
              aria-label="Voltar ao topo da conversa"
              title="Voltar ao topo da conversa"
            >
              ↑ Topo
            </button>
            {authConfigured ? (
              authenticated ? (
                <>
                  {me?.admin_access ? (
                    <Link className="ghost-link" to="/admin">
                      Painel admin
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      void nativeLogout().finally(() => {
                      setAuthenticated(false);
                        setMe(null);
                      });
                    }}
                  >
                    Sair
                  </button>
                </>
              ) : (
                <Link className="ghost-link" to="/access">
                  Entrar
                </Link>
              )
            ) : null}
            {["owner", "moderator"].includes(
              threads.find((item) => item.id === threadId)?.thread_role || "",
            ) ? (
              <button
                type="button"
                className="console-header__invite"
                onClick={() => { setShowInvite(true); void refreshParticipants(); }}
                disabled={!accountReady || !threadId}
                aria-label="Gerenciar participantes e permissões desta conversa"
                title="Gerenciar participantes e permissões desta conversa"
              >
                <span className="console-header__invite-icon" aria-hidden="true">+</span>
                <span className="console-header__invite-label">Pessoas e vínculos</span>
              </button>
            ) : null}
          </div>
        </header>

        {!authenticated ? (
          <div className="console-alert" role="alert">
            <span>
              {authConfigured
                ? "Autentique-se para usar conversas, anexos e convites."
                : "A API ainda não está configurada nesta implantação."}
            </span>
            {authConfigured ? (
              <Link className="primary-button" to="/access">
                Entrar
              </Link>
            ) : null}
          </div>
        ) : null}
        {authenticated && provisioningBlocked ? (
          <div className="console-alert console-alert--provisioning" role="alert">
            <div>
              <strong>Conta autenticada; ativação pendente.</strong>
              <span>
                O cadastro foi concluído, mas esta identidade ainda não está vinculada à organização PatroAI.
              </span>
            </div>
            <Link className="primary-button" to="/access">
              Ativar acesso PatroAI
            </Link>
          </div>
        ) : null}
        {!configured ? (
          <p className="console-alert" role="alert">
            A URL da API não está configurada nesta implantação.
          </p>
        ) : null}
        {error ? (
          <p className="console-alert" role="alert">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p className="console-notice" role="status">
            {notice}
          </p>
        ) : null}

        <section
          ref={threadViewportRef}
          className="thread"
          aria-label="Conversa"
          aria-busy={loading || sending}
          onScroll={(event) => {
            const viewport = event.currentTarget;
            const remaining =
              viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
            followLatestRef.current = remaining <= 96;
          }}
        >
          {loading && messages.length === 0 ? (
            <div className="thread-state" role="status">
              <span className="thread-state__pulse" aria-hidden="true" />
              Carregando conversa…
            </div>
          ) : messages.length === 0 && !streamingText ? (
            <article className="message agent message--welcome">
              <header className="message__meta">
                <span className="message__author">{selectedAgentName}</span>
                <span>Pronto para conversar</span>
              </header>
              <p>Onde a inteligência encontra harmonia.</p>
            </article>
          ) : (
            messages.map((item) => (
              <article
                key={item.id}
                className={item.author_type === "agent" ? "message agent" : "message user"}
              >
                <header className="message__meta">
                  <span className="message__author">
                    {item.author_type === "agent"
                      ? visibleAgentAuthor(item.agent_name)
                      : visibleHumanAuthor(item)}
                  </span>
                  <time
                    dateTime={item.created_at}
                    title={formatDateTimeTitle(item.created_at)}
                  >
                    {formatMessageTimestamp(item.created_at)}
                  </time>
                </header>
                <SafeMarkdown content={item.content} />
                {item.author_type === "agent" ? (
                  <footer className="message__actions">
                    <button
                      type="button"
                      className={
                        speakingMessageId === item.id
                          ? "speaker-button speaker-button--playing"
                          : "speaker-button"
                      }
                      onClick={() => void handleMessageVoice(item.id)}
                      aria-pressed={speakingMessageId === item.id}
                      title={
                        speakingMessageId === item.id
                          ? "Parar reprodução"
                          : "Ouvir resposta com a voz canônica deste agente"
                      }
                    >
                      <span aria-hidden="true">🔊</span>
                      <span>
                        {speakingMessageId === item.id ? "Parar" : "Ouvir"}
                      </span>
                    </button>
                  </footer>
                ) : null}
              </article>
            ))
          )}
          {streamingText ? (
            <article className="message agent message--streaming" aria-live="polite">
              <header className="message__meta">
                <span className="message__author">
                  {executionTargetName}
                </span>
                <span className="streaming-status">
                  <span className="streaming-status__dot" aria-hidden="true" />
                  Gerando
                </span>
              </header>
              <SafeMarkdown content={streamingText} />
            </article>
          ) : null}
        </section>

        {artifacts.length > 0 ? (
          <section
            className="artifact-delivery"
            aria-label="Arquivos gerados nesta sessão"
            aria-live="polite"
          >
            {artifacts.map((artifact) => (
              <ArtifactCard
                key={artifact.artifact_id}
                artifact={artifact}
                busy={artifactDownloadBusy === artifact.artifact_id}
                error={artifactDownloadErrors[artifact.artifact_id] || ""}
                onDownload={(item) => void handleArtifactDownload(item)}
              />
            ))}
          </section>
        ) : null}

        <footer className="composer">
          <div className="composer__status" aria-live="polite">
            <span>
              {sending
                ? executionMode === "human" ? "Enviando mensagem aos participantes…" : teamRunStatus || `Gerando resposta com ${executionTargetName}…`
                : voiceState === "recording"
                  ? `Gravando ${formatVoiceElapsed(voiceElapsed)} · máx. ${formatVoiceElapsed(VOICE_MAX_RECORDING_SECONDS)}`
                  : voiceState === "transcribing"
                    ? "Transcrevendo voz…"
                    : voiceState === "review"
                      ? "Transcrição pronta — revise e envie."
                      : uploading
                        ? "Enviando anexo…"
                        : documentProvenanceLabel
                          ? documentProvenanceLabel
                          : recentAttachment
                            ? `Anexo enviado: ${recentAttachment}`
                            : realtimeActive
                              ? realtimePartialTranscript
                                ? `Realtime · ${realtimeStateLabel[realtimeState]} · “${realtimePartialTranscript}”`
                                : `Realtime · ${realtimeStateLabel[realtimeState]}`
                              : "Enter para enviar · Shift+Enter para nova linha"}
            </span>
            <span className="composer__agent">
              {executionTargetName} · {executionTargetRole}
            </span>
          </div>
          {realtimeActive && realtimeTransportDiagnostic ? (
            <p className="realtime-transport-diagnostic" aria-live="off">
              Diagnóstico local: {realtimeTransportDiagnostic}
            </p>
          ) : null}
          <div className="composer__row">
            <div className="composer__editor">
          <LargePasteDecision capabilities={documentIntake.capabilities} view={documentIntake.view} onConfirm={(title) => void documentIntake.confirm(title)} onCancel={documentIntake.cancel} />
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onPaste={handleComposerPaste}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            placeholder="Digite sua mensagem."
            aria-label="Mensagem"
            disabled={
              sending ||
              !accountReady ||
              voiceState === "recording" ||
              voiceState === "transcribing"
            }
          />
            </div>
            <div className="composer__actions" role="group" aria-label="Ações de mensagem">
          <label
            className={
              !accountReady || !threadId || !threadPermissions?.can_upload_files || sending || uploading
                ? "attachment-button attachment-button--disabled"
                : "attachment-button"
            }
            aria-label="Anexar documento"
            aria-disabled={!accountReady || !threadId || !threadPermissions?.can_upload_files || sending || uploading}
            title="Anexar PDF, DOCX, XLSX, PPTX, TXT, CSV ou JSON"
          >
            <span className="attachment-button__icon" aria-hidden="true">📎</span>
            <span className="attachment-button__label">
              {uploading ? "Enviando…" : "Anexar"}
            </span>
            <input
              type="file"
              hidden
              ref={fileRef}
              accept={ATTACHMENT_ACCEPT}
              onChange={handleFile}
              disabled={!accountReady || !threadId || !threadPermissions?.can_upload_files || sending || uploading}
            />
          </label>
          <button
            type="button"
            className={executionMode === "human" ? "agent-trigger agent-mode__active" : "agent-trigger"}
            aria-pressed={executionMode === "human"}
            onClick={() => {
              if (executionMode !== "human") {
                if (realtimeActive) {
                  setError("Encerre a sessão Realtime antes de entrar no modo Pessoas.");
                  return;
                }
                setExecutionMode("human");
                setNotice("Modo Pessoas: suas mensagens não chamam agentes.");
              } else {
                setExecutionMode("individual");
                setNotice("Modo Agente ativado para a próxima mensagem.");
              }
            }}
            disabled={!accountReady || sending || realtimeActive}
            title={executionMode === "human" ? "Voltar ao modo Agente" : "Conversar apenas com pessoas, sem IA"}
          >
            <span aria-hidden="true">👥</span>
            <span className="agent-trigger__label">{executionMode === "human" ? "Pessoas ✓" : "Pessoas"}</span>
          </button>
          <button
            type="button"
            className="agent-trigger"
            onClick={() => setShowAgents(true)}
            disabled={!accountReady || agentsBusy}
            aria-label={executionMode === "human"
              ? "Convocar agente para analisar a conversa autorizada"
              : `Selecionar agente. Ativo: ${executionTargetName}`}
            title="Escolha o agente que poderá trabalhar sobre o histórico autorizado"
          >
            <span aria-hidden="true">✦</span>
            <span className="agent-trigger__label">{executionMode === "human" ? "Convocar agente" : executionTargetName}</span>
          </button>
          <button
            type="button"
            className={
              voiceState === "recording"
                ? "icon-button voice-button voice-button--recording"
                : voiceState === "review"
                  ? "icon-button voice-button voice-button--review"
                  : "icon-button voice-button voice-button--ready"
            }
            aria-label={
              voiceState === "recording" ? "Parar gravação" : "Gravar voz"
            }
            title={
              voiceState === "recording"
                ? "Parar e transcrever"
                : voiceState === "review"
                  ? "Gravar novamente"
                  : `Gravar mensagem de voz (máx. ${VOICE_MAX_RECORDING_SECONDS}s)`
            }
            onClick={handleVoiceButton}
            disabled={
              !authenticated ||
              !configured ||
              !threadId ||
              sending ||
              uploading ||
              voiceState === "transcribing"
            }
            aria-pressed={voiceState === "recording"}
          >
            {voiceState === "recording" ? "■" : "🎙"}
          </button>
          {voiceState === "review" ? (
            <button
              type="button"
              className="voice-review__discard"
              onClick={() => cancelVoiceCapture(true)}
              disabled={sending}
            >
              Descartar
            </button>
          ) : null}
          <button
            type="button"
            className={`realtime-button composer__realtime realtime-button--${realtimeState} ${
              realtimeReady ? "realtime-button--ready" : "realtime-button--pending"
            }`}
            onClick={handleRealtimeButton}
            aria-pressed={realtimeActive}
            aria-label={realtimeActive ? "Encerrar Realtime" : "Abrir Realtime"}
            title={realtimeReady ? (realtimeActive ? "Encerrar Realtime" : "Iniciar Realtime") : "Ver requisitos do Realtime"}
          >
            <span className="realtime-button__pulse" aria-hidden="true" />
            <span className="realtime-button__icon" aria-hidden="true">◉</span>
            <span className="realtime-button__copy"><strong>Realtime</strong></span>
          </button>
          <button
            type="button"
            className="primary-button composer__send"
            onClick={handleSend}
            disabled={
              sending ||
              !message.trim() ||
              !accountReady ||
              !configured ||
              voiceState === "recording" ||
              voiceState === "transcribing"
            }
          >
            {sending ? (executionMode === "human" ? "Enviando…" : "Gerando…") : "Enviar"}
          </button>
            </div>
          </div>
        </footer>
      </main>



      {showRenameThread ? (
        <div className="modal" role="presentation">
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-thread-title"
          >
            <div className="agent-picker__heading">
              <div>
                <span className="console-header__eyebrow">Conversa ativa</span>
                <h2 id="rename-thread-title">Renomear conversa</h2>
                <p>Use um nome curto para encontrar este contexto rapidamente na sidebar.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowRenameThread(false)}
                aria-label="Fechar renomeação de conversa"
              >
                ×
              </button>
            </div>
            <label className="field">
              <span>Nome da conversa</span>
              <input
                value={renameThreadValue}
                onChange={(event) => setRenameThreadValue(event.target.value)}
                maxLength={240}
                placeholder="Ex.: Plano de expansão 2026"
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => setShowRenameThread(false)}
                disabled={renameThreadBusy}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void saveThreadTitle()}
                disabled={renameThreadBusy || renameThreadValue.trim().length < 1}
              >
                {renameThreadBusy ? "Salvando…" : "Salvar nome"}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {showRenameCoCreator ? (
        <div className="modal" role="presentation">
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-cocreator-title"
          >
            <div className="agent-picker__heading">
              <div>
                <h2 id="rename-cocreator-title">Renomear Co-Criador</h2>
                <p>O nome é pessoal e não altera a identidade técnica do agente.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowRenameCoCreator(false)}
                aria-label="Fechar"
              >
                ×
              </button>
            </div>
            <label className="field">
              <span>Nome do Co-Criador</span>
              <input
                value={renameCoCreatorValue}
                onChange={(event) => setRenameCoCreatorValue(event.target.value)}
                maxLength={64}
                placeholder="Ex.: Atlas, Sophia, Nexo…"
                autoFocus
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => setShowRenameCoCreator(false)}
                disabled={renameCoCreatorBusy}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void saveCoCreatorName()}
                disabled={renameCoCreatorBusy || renameCoCreatorValue.trim().length < 2}
              >
                {renameCoCreatorBusy ? "Salvando…" : "Salvar nome"}
              </button>
            </div>
          </section>
        </div>
      ) : null}


      {showAgents ? (
        <div className="modal" role="presentation">
          <section
            className="modal-card agent-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-picker-title"
          >
            <div className="agent-picker__heading">
              <div>
                <h2 id="agent-picker-title">Inteligência colaborativa</h2>
                <p>Escolha o especialista que será solicitado para o próximo turno.</p>
              </div>
              <button type="button" onClick={() => setShowAgents(false)} aria-label="Fechar">
                ×
              </button>
            </div>

            <div className="agent-mode" aria-label="Modo de execução">
              <button
                type="button"
                className={executionMode === "human" ? "agent-mode__active" : ""}
                aria-pressed={executionMode === "human"}
                disabled={sending || realtimeActive}
                onClick={() => { setExecutionMode("human"); setShowAgents(false); }}
              >
                Pessoas · sem IA
              </button>
              <button
                type="button"
                className={executionMode === "individual" ? "agent-mode__active" : ""}
                aria-pressed={executionMode === "individual"}
                onClick={() => setExecutionMode("individual")}
              >
                Individual
              </button>
              {me?.admin_access ? (
                <button
                  type="button"
                  className={executionMode === "team" ? "agent-mode__active" : ""}
                  aria-pressed={executionMode === "team"}
                  disabled={!accountReady}
                  onClick={() => {
                    setExecutionMode("team");
                    void refreshTeams();
                  }}
                  title={
                    accountReady
                      ? "Selecionar formação Team governada"
                      : "Ative sua conta PatroAI para usar Team"
                  }
                >
                  Team
                </button>
              ) : null}
            </div>

            {executionMode === "team" ? (
              <div className="team-config" aria-label="Configuração do Team">
                <div className="team-config__heading">
                  <div>
                    <strong>Team governado</strong>
                    <small>
                      PatroAI é o chair canônico · selecione de {teamMin} a {activeTeam?.participant_policy.max_contributors ?? 0} especialistas
                    </small>
                  </div>
                  <span className="team-config__count">
                    {teamSelectionMode === "all_eligible"
                      ? `${teamEligibleCount} todos`
                      : `${teamParticipants.length}/${activeTeam?.participant_policy.max_contributors ?? 0}`}
                  </span>
                </div>
                <div className="team-config__toolbar">
                  <button
                    type="button"
                    className="team-config__select-all"
                    onClick={selectAllTeamContributors}
                    disabled={!activeTeam?.participant_policy.select_all_supported}
                    title={
                      activeTeam?.participant_policy.select_all_supported
                        ? "Selecionar todos os especialistas elegíveis"
                        : `${teamEligibleCount} elegíveis · limite atual ${teamMax}. O backend liberará esta opção quando a carga estiver comprovada.`
                    }
                  >
                    Selecionar todos
                  </button>
                  <button
                    type="button"
                    className="team-config__clear"
                    onClick={clearTeamContributors}
                  >
                    Limpar
                  </button>
                  {!activeTeam?.participant_policy.select_all_supported ? (
                    <small className="team-config__limit-note">
                      {teamEligibleCount} elegíveis · limite operacional {teamMax}
                    </small>
                  ) : null}
                </div>
                {teamsBusy ? <p role="status">Carregando Teams…</p> : null}
                {teamsError ? <p className="console-alert" role="alert">{teamsError}</p> : null}
                {teams.length ? (
                  <label className="team-config__select">
                    Formação
                    <select
                      value={selectedTeamId}
                      onChange={(event) => selectTeamDefinition(event.target.value)}
                    >
                      {teams.map((team) => (
                        <option key={team.team_id} value={team.team_id}>
                          {team.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            ) : null}

            {agentsBusy ? <p role="status">Carregando Agent Registry…</p> : null}
            {agentsError ? (
              <div className="console-alert" role="alert">
                <span>{agentsError}</span>
                <button type="button" onClick={() => void refreshAgents()}>
                  Tentar novamente
                </button>
              </div>
            ) : null}
            {!agentsBusy && !agentsError && agents.length === 0 ? (
              <p className="agent-picker__empty">Nenhum agente disponível no Registry.</p>
            ) : null}

            <div className="agent-grid" role="list" aria-label="Agentes disponíveis">
              {agents
                .filter((agent) => {
                  if (executionMode !== "team" || !activeTeam) return true;
                  return (
                    agent.slug === activeTeam.orchestrator_agent_id ||
                    activeTeam.candidate_contributor_agent_ids.includes(agent.slug)
                  );
                })
                .map((agent) => {
                  const individualActive = selectedAgent?.slug === agent.slug;
                  const teamActive = teamParticipants.includes(agent.slug);
                  const orchestrator =
                    executionMode === "team" &&
                    activeTeam?.orchestrator_agent_id === agent.slug;
                  const active =
                    executionMode === "team"
                      ? orchestrator || teamActive
                      : individualActive;
                  const agentDisplayName = agent.display_name;
                  return (
                    <button
                      type="button"
                      role="listitem"
                      key={agent.slug}
                      className={active ? "agent-card agent-card--active" : "agent-card"}
                      aria-pressed={active}
                      disabled={Boolean(orchestrator)}
                      onClick={() => {
                        if (executionMode === "team") {
                          toggleTeamParticipant(agent.slug);
                          return;
                        }
                        setSelectedAgent(agent);
                        setExecutionMode("individual");
                        setShowAgents(false);
                        setNotice(`Agente ${agentDisplayName} convocado. Escreva o que deseja que ele analise no histórico autorizado.`);
                      }}
                    >
                      <span className="agent-card__avatar" aria-hidden="true">
                        {agentDisplayName.slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        <strong>{agentDisplayName}</strong>
                        <small>
                          {orchestrator
                            ? "Orquestrador canônico"
                            : agent.target_kind === "agent"
                              ? "Agente especializado"
                              : agent.target_kind}
                        </small>
                      </span>
                      <span className="agent-card__status">
                        {orchestrator
                          ? "Fixo"
                          : active
                            ? executionMode === "team"
                              ? "No Team"
                              : "Ativo"
                            : "Disponível"}
                      </span>
                    </button>
                  );
                })}
            </div>

            <p className="agent-picker__governance">
              {executionMode === "team"
                ? "O chair do Team vem do contrato do backend e nunca executa como especialista; o navegador seleciona apenas contributors permitidos."
                : "O executor real é resolvido pelo backend. A interface não substitui a identidade de execução."}
            </p>
          </section>
        </div>
      ) : null}
      {showRealtimeInfo ? (
        <div className="modal" role="presentation">
          <section
            className="modal-card realtime-status-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="realtime-status-title"
          >
            <div className="agent-picker__heading">
              <div>
                <span className="console-header__eyebrow">Capability status</span>
                <h2 id="realtime-status-title">Realtime</h2>
                <p>
                  Sessão de voz canônica: microfone → transcrição → PatroAI → persistência → mesma voz do botão 🔊.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowRealtimeInfo(false)}
                aria-label="Fechar status do Realtime"
              >
                ×
              </button>
            </div>
            <div className="realtime-status">
              <div>
                <span>Sessão WebRTC</span>
                <strong>
                  {realtimeCapabilities?.realtime_session?.eligible
                    ? "Elegível"
                    : "Não liberada"}
                </strong>
              </div>
              <div>
                <span>Ponte de orquestração</span>
                <strong>
                  {realtimeCapabilities?.orchestration_bridge?.eligible
                    ? "Elegível"
                    : "Pendente"}
                </strong>
              </div>
              <div>
                <span>Entrada de voz</span>
                <strong>
                  {realtimeCapabilities?.voice_input?.eligible ? "Elegível" : "Pendente"}
                </strong>
              </div>
              <div>
                <span>Saída de voz</span>
                <strong>
                  {realtimeCapabilities?.voice_output?.eligible ? "Elegível" : "Pendente"}
                </strong>
              </div>
              <div>
                <span>Voz por segmentos</span>
                <strong>
                  {realtimeCapabilities?.voice_segment_streaming?.eligible
                    ? "Disponível"
                    : "Fallback completo"}
                </strong>
              </div>
              <div>
                <span>Runtime comprovado</span>
                <strong>{realtimeCapabilities?.runtime_proven ? "Sim" : "Ainda não"}</strong>
              </div>
              <div>
                <span>Estado</span>
                <strong>{realtimeStateLabel[realtimeState]}</strong>
              </div>
            </div>
            {!realtimeReady ? (
              <p className="realtime-status__reason">
                {describe(new ApiError(0, realtimeReason))}
              </p>
            ) : null}
            <p className="agent-picker__governance">
              Voice Message (gravar → transcrever → revisar → enviar) permanece separado do
              Realtime. O Realtime só inicia quando sessão, bridge, input e output estão elegíveis;
              a resposta canônica é persistida pela plataforma antes da reprodução por voz.
            </p>
            <div className="modal-card__actions">
              <button
                type="button"
                onClick={() => void refreshRealtimeCapabilities()}
                disabled={realtimeBusy}
              >
                {realtimeBusy ? "Verificando…" : "Atualizar status"}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => setShowRealtimeInfo(false)}
              >
                Entendi
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {showInvite ? (
        <div className="modal" role="presentation">
          <section
            className="modal-card people-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="people-panel-title"
          >
            <div className="people-panel__heading">
              <div>
                <h2 id="people-panel-title">Pessoas e vínculos</h2>
                <p>Permissões exclusivas desta conversa, administradas pelo servidor.</p>
              </div>
              <button type="button" onClick={() => setShowInvite(false)} aria-label="Fechar painel">
                ×
              </button>
            </div>
            <div className="people-panel__section">
              <h3>Novo convite</h3>
              <label>
                E-mail do colaborador
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="email@empresa.com"
                />
              </label>
              <label>
                Histórico da conversa
                <select
                  value={inviteHistory}
                  onChange={(event) => setInviteHistory(event.target.value as ThreadGrant["history_access"])}
                >
                  <option value="from_join">Somente a partir da entrada</option>
                  <option value="full_thread">Conversa inteira, incluindo mensagens anteriores</option>
                </select>
              </label>
              <label>
                Duração do acesso após aceitar (horas)
                <input type="number" min={1} max={8760} step={1}
                  value={inviteAccessHours} disabled={inviteUnlimitedAccess}
                  onChange={(event) => setInviteAccessHours(event.target.value)} />
                <small>O link do convite continua tendo prazo próprio de 72 horas, configurado no servidor.</small>
              </label>
              <label className="people-panel__toggle">
                <input type="checkbox" checked={inviteUnlimitedAccess}
                  onChange={(event) => setInviteUnlimitedAccess(event.target.checked)} />
                Acesso sem vencimento (até revogação manual)
              </label>
              <label className="people-panel__toggle">
                <input type="checkbox" checked={inviteCanRead}
                  onChange={(event) => setInviteCanRead(event.target.checked)} />
                Pode ler mensagens do histórico autorizado
              </label>
              <label className="people-panel__toggle">
                <input type="checkbox" checked={inviteCanWrite}
                  onChange={(event) => setInviteCanWrite(event.target.checked)} />
                Pode escrever mensagens e interagir com agentes
              </label>
              <label>
                Agente disponível ao colaborador
                <select
                  value={inviteAgentId}
                  onChange={(event) => setInviteAgentId(event.target.value)}
                >
                  {agents.map((agent) => (
                    <option key={agent.slug} value={agent.slug}>{agent.display_name}</option>
                  ))}
                </select>
              </label>
              <label className="people-panel__toggle">
                <input
                  type="checkbox"
                  checked={inviteCanUpload}
                  onChange={(event) => setInviteCanUpload(event.target.checked)}
                />
                Permitir anexar documentos (desativado por padrão)
              </label>
              <label className="people-panel__toggle">
                <input type="checkbox" checked={inviteCanViewDocuments}
                  onChange={(event) => setInviteCanViewDocuments(event.target.checked)} />
                Pode consultar documentos autorizados
              </label>
              <label className="people-panel__toggle">
                <input type="checkbox" checked={inviteCanDownloadArtifacts}
                  onChange={(event) => setInviteCanDownloadArtifacts(event.target.checked)} />
                Pode consultar ou baixar artefatos gerados
              </label>
              <label className="people-panel__toggle">
                <input type="checkbox" checked={inviteCanGenerateArtifacts}
                  onChange={(event) => setInviteCanGenerateArtifacts(event.target.checked)} />
                Pode gerar novos artefatos
              </label>
              <p className="people-panel__hint">
                O acesso é exclusivo desta conversa. O histórico completo exige concessão explícita.
                Revogar a leitura impede novos acessos, mas não apaga cópias já vistas ou exportadas.
              </p>
              {inviteError ? <p className="console-alert" role="alert">{inviteError}</p> : null}
              {inviteUrl ? (
                <div className="people-panel__invite-link">
                  <strong>Convite criado</strong>
                  <output>{inviteUrl}</output>
                  <small>
                    {inviteDeliveryStatus === "link_only"
                      ? "Link gerado; compartilhe com a pessoa convidada."
                      : "Compartilhe o link diretamente com o convidado."}
                  </small>
                </div>
              ) : null}
              <button
                type="button"
                className="primary-button"
                onClick={invite}
                disabled={inviteBusy || !accountReady || !email.trim() || !agents.some((agent) => agent.slug === inviteAgentId)
                  || (!inviteUnlimitedAccess && (!Number.isInteger(Number(inviteAccessHours))
                    || Number(inviteAccessHours) < 1 || Number(inviteAccessHours) > 8760))}
              >
                {inviteBusy ? "Criando convite…" : "Criar convite com essas permissões"}
              </button>
            </div>
            <div className="people-panel__section">
              <div className="people-panel__heading">
                <h3>Participantes da conversa</h3>
                <button type="button" onClick={() => void refreshParticipants()} disabled={participantsBusy}>
                  {participantsBusy ? "Atualizando…" : "Atualizar"}
                </button>
              </div>
              {participantError ? <p className="console-alert" role="alert">{participantError}</p> : null}
              {participants.length === 0 && !participantsBusy ? (
                <p className="people-panel__hint">Nenhum participante listado ou acesso indisponível.</p>
              ) : null}
              {participants.map((person) => {
                const draft = participantDrafts[person.user_id];
                const owner = person.role === "owner";
                const canEdit = threads.find((item) => item.id === threadId)?.thread_role === "owner" && !owner;
                return (
                  <details className="people-panel__person" key={person.id}>
                    <summary>
                      <strong>{person.display_name || person.email || person.user_id}</strong>
                      <span>{owner ? "Proprietário" : person.access_expired ? "Prazo encerrado" : person.role === "moderator" ? "Moderador" : "Colaborador"}</span>
                    </summary>
                    {draft ? (
                      <div className="people-panel__fields">
                        <label>
                          Histórico
                          <select
                            value={draft.history_access}
                            disabled={!canEdit || participantAction === person.user_id}
                            onChange={(event) => setParticipantDrafts((current) => ({
                              ...current,
                              [person.user_id]: { ...draft, history_access: event.target.value as ThreadGrant["history_access"] },
                            }))}
                          >
                            <option value="from_join">A partir da entrada</option>
                            <option value="full_thread">Histórico completo</option>
                          </select>
                        </label>
                        {([
                          ["can_read_messages", "Ler histórico autorizado"],
                          ["can_write_messages", "Escrever mensagens"],
                          ["can_view_attachments", "Consultar documentos"],
                          ["can_upload_files", "Anexar documentos"],
                          ["can_download_artifacts", "Consultar ou baixar artefatos"],
                          ["can_generate_artifacts", "Gerar artefatos"],
                        ] as const).map(([field, title]) => (
                          <label key={field} className="people-panel__toggle">
                            <input type="checkbox" checked={draft[field]}
                              disabled={!canEdit || participantAction === person.user_id}
                              onChange={(event) => setParticipantDrafts((current) => ({
                                ...current,
                                [person.user_id]: { ...draft, [field]: event.target.checked },
                              }))} />
                            {title}
                          </label>
                        ))}
                        <label>
                          Agente permitido
                          <select
                            value={draft.allowed_agent_ids[0] || "orkio"}
                            disabled={!canEdit || participantAction === person.user_id}
                            onChange={(event) => setParticipantDrafts((current) => ({
                              ...current,
                              [person.user_id]: { ...draft, allowed_agent_ids: [event.target.value] },
                            }))}
                          >
                            {agents.map((agent) => (
                              <option key={agent.slug} value={agent.slug}>{agent.display_name}</option>
                            ))}
                          </select>
                        </label>
                        {canEdit ? (
                          <div className="people-panel__fields">
                            <p className="people-panel__hint">
                              {person.access_expired
                                ? "Acesso expirado; a pessoa não pode entrar nesta conversa."
                                : person.access_expires_at
                                  ? `Acesso válido até ${new Date(person.access_expires_at).toLocaleString("pt-BR")}`
                                  : "Acesso sem prazo definido (até revogação)."}
                            </p>
                            <label>
                              Renovar ou alterar prazo (horas)
                              <input type="number" min={1} max={8760} step={1}
                                value={participantAccessHours[person.user_id] ?? "72"}
                                onChange={(event) => setParticipantAccessHours((current) => ({
                                  ...current, [person.user_id]: event.target.value,
                                }))}
                                disabled={Boolean(participantAction)} />
                              <small>Deixe vazio para conceder acesso sem vencimento.</small>
                            </label>
                            <button type="button"
                              disabled={Boolean(participantAction)}
                              onClick={() => void renewParticipantAccess(person.user_id)}>
                              Aplicar novo prazo
                            </button>
                          </div>
                        ) : null}
                        {canEdit ? (
                          <div className="people-panel__person-actions">
                            <button
                              type="button"
                              className="primary-button"
                              disabled={Boolean(participantAction)}
                              onClick={() => void saveParticipant(person.user_id)}
                            >
                              Salvar permissões
                            </button>
                            <button
                              type="button"
                              disabled={Boolean(participantAction)}
                              onClick={() => void removeParticipant(person.user_id)}
                            >
                              Revogar vínculo
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <p>As permissões individuais não estão disponíveis.</p>
                    )}
                  </details>
                );
              })}
            </div>
            <div className="modal-card__actions">
              <button type="button" onClick={() => setShowInvite(false)}>Fechar</button>
            </div>
          </section>
        </div>
      ) : null}
      </div>
    </LegacyConversationAdapter>
  );
}
