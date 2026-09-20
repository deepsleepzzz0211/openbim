import { create } from "zustand";
import { api, setTokens, setUnauthorizedHandler } from "../api/client";

interface AuthState {
  accessToken: string | null;
  user: { id: string; name: string; email: string; role: string } | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, name: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

function persist(tokens: { accessToken: string; refreshToken: string }, user: AuthState["user"]) {
  localStorage.setItem("obh.tokens", JSON.stringify(tokens));
  localStorage.setItem("obh.user", JSON.stringify(user));
  setTokens(tokens);
}

const storedTokens = (() => {
  try {
    const t = JSON.parse(localStorage.getItem("obh.tokens") || "null");
    if (t?.accessToken) setTokens(t);
    return t;
  } catch {
    return null;
  }
})();
const storedUser = (() => {
  try {
    return JSON.parse(localStorage.getItem("obh.user") || "null");
  } catch {
    return null;
  }
})();

export const useAuth = create<AuthState>((set) => ({
  accessToken: storedTokens?.accessToken ?? null,
  user: storedUser,
  login: async (email, password) => {
    const data = await api.post<{
      accessToken: string;
      refreshToken: string;
      user: AuthState["user"];
    }>("/auth/login", { email, password });
    persist({ accessToken: data.accessToken, refreshToken: data.refreshToken }, data.user);
    set({ accessToken: data.accessToken, user: data.user });
  },
  register: async (email, name, password) => {
    const data = await api.post<{
      accessToken: string;
      refreshToken: string;
      user: AuthState["user"];
    }>("/auth/register", { email, name, password });
    persist({ accessToken: data.accessToken, refreshToken: data.refreshToken }, data.user);
    set({ accessToken: data.accessToken, user: data.user });
  },
  logout: async () => {
    const tokens = JSON.parse(localStorage.getItem("obh.tokens") || "null");
    if (tokens?.refreshToken) {
      await api.post("/auth/logout", { refreshToken: tokens.refreshToken }).catch(() => undefined);
    }
    localStorage.removeItem("obh.tokens");
    localStorage.removeItem("obh.user");
    setTokens(null);
    set({ accessToken: null, user: null });
  },
}));

setUnauthorizedHandler(() => {
  useAuth.setState({ accessToken: null, user: null });
  window.location.hash = "";
  window.location.href = "/login";
});
