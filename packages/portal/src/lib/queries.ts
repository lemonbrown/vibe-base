import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { PlatformRole, JobKind, OwnerSettings } from "@vibe/shared";
import { api } from "./api";

/* -------------------------------- queries ------------------------------- */

export function useApps() {
  return useQuery({
    queryKey: ["apps"],
    queryFn: api.listApps,
    refetchInterval: 15_000,
  });
}

export function useAppStatus(id: string) {
  return useQuery({
    queryKey: ["app", id, "status"],
    queryFn: () => api.getAppStatus(id),
    refetchInterval: 15_000,
  });
}

export function useMembers(id: string) {
  return useQuery({
    queryKey: ["app", id, "members"],
    queryFn: () => api.getMembers(id),
  });
}

export function useDeployments(id: string) {
  return useQuery({
    queryKey: ["app", id, "deployments"],
    queryFn: () => api.getDeployments(id),
  });
}

export function useLogs(id: string, build: boolean) {
  return useQuery({
    queryKey: ["app", id, "logs", build ? "build" : "runtime"],
    queryFn: () => api.getLogs(id, { build, tail: 300 }),
    refetchInterval: build ? false : 8_000,
  });
}

export function useConversations() {
  return useQuery({
    queryKey: ["conversations"],
    queryFn: api.listConversations,
  });
}

export function useConversation(id: string) {
  return useQuery({
    queryKey: ["conversation", id],
    queryFn: () => api.getConversation(id),
  });
}

export function useMachineStatus() {
  return useQuery({
    queryKey: ["machine"],
    queryFn: api.getMachineStatus,
    refetchInterval: 20_000,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: api.getSettings,
    staleTime: 60_000,
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<OwnerSettings>) => api.updateSettings(patch),
    onSuccess: (settings) => qc.setQueryData(["settings"], settings),
  });
}

/* ------------------------------- mutations ------------------------------ */

export function useInvite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; role: PlatformRole }) =>
      api.invite(id, v.email, v.role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id, "members"] }),
  });
}

export function useRevoke(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => api.revoke(id, email),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["app", id, "members"] }),
  });
}

export function useRollback(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.rollback(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app", id] });
      qc.invalidateQueries({ queryKey: ["apps"] });
    },
  });
}

export function useDeleteApp(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteApp(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["apps"] }),
  });
}

export function useNewConversation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.newConversation(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

export function useSendMessage(convId: string) {
  return useMutation({
    mutationFn: (v: {
      content: string;
      kind: JobKind;
      targetApp: string | null;
      planMode: boolean;
    }) => api.sendMessage(convId, v),
  });
}
