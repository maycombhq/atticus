import { api } from "@/lib/api-client";

export const getComments = (noteId: string) => api.get(`/notes/${noteId}/comments`);

export const addComment = (noteId: string, text: string) =>
  api.post(`/notes/${noteId}/comments`, { text });

export const deleteComment = (id: string) => api.delete(`comments/${id}`);
