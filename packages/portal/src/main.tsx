import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router-dom";
import "./index.css";
import { AppShell } from "./components/AppShell";
import { AppsPage } from "./pages/AppsPage";
import { AppDetailPage } from "./pages/AppDetailPage";
import { ChatListPage } from "./pages/ChatListPage";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { MembersPage } from "./pages/MembersPage";
import { ErrorState } from "./components/States";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

const router = createBrowserRouter([
  {
    element: <AppShell />,
    errorElement: <ErrorState />,
    children: [
      { path: "/", element: <AppsPage /> },
      { path: "/apps/:id", element: <AppDetailPage /> },
      { path: "/chat", element: <ChatListPage /> },
      { path: "/chat/:id", element: <ChatPage /> },
      { path: "/members", element: <MembersPage /> },
      { path: "/settings", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>
);
