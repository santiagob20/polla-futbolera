"use client";

import React, { useState, useEffect } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  collection,
  query,
  onSnapshot,
  orderBy,
  doc,
  setDoc,
  getDocs,
  getDoc,
  writeBatch
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { calculatePoints, calculatePointsOld, calculatePointsNew } from "@/lib/scoreCalculator";
import { getFlagUrl } from "@/lib/flags";

// Interfaces
interface Match {
  id: string;
  round: string;
  date: string;
  time: string;
  team1: string;
  team2: string;
  group: string | null;
  ground: string;
  num: number;
  result: { goals1: number; goals2: number; isFinal?: boolean } | null;
}

interface Prediction {
  id: string;
  userId: string;
  matchId: string;
  goals1: number;
  goals2: number;
  points: number;
}

interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  points: number;
  previousPoints?: number;
  isAdmin?: boolean;
}

// Helper functions for dates and timezones
const getMatchDate = (match: Match): Date => {
  const [timeStr, tzStr] = match.time.split(" ");
  let offset = "-06:00"; // default fallback
  if (tzStr) {
    const tzMatch = tzStr.match(/UTC([+-]\d+)/);
    if (tzMatch) {
      const val = parseInt(tzMatch[1]);
      const sign = val >= 0 ? "+" : "-";
      const absVal = Math.abs(val);
      const hours = String(absVal).padStart(2, "0");
      offset = `${sign}${hours}:00`;
    }
  }
  return new Date(`${match.date}T${timeStr}:00${offset}`);
};

const isMatchPast = (match: Match): boolean => {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  if (getMatchDate(match).getTime() < todayStart.getTime()) return true;
  // Also treat today's finalized matches as past (archived)
  return match.result !== null && match.result.isFinal !== false;
};

const hasMatchStarted = (match: Match): boolean => {
  if (match.result !== null) {
    return true;
  }
  return Date.now() >= getMatchDate(match).getTime();
};

const formatRoundName = (round: string): string => {
  if (!round) return "";
  return round
    .replace(/Matchday\s+(\d+)/gi, "Día $1")
    .replace(/Round of 32/gi, "Dieciseisavos")
    .replace(/Round of 16/gi, "Octavos")
    .replace(/Quarter-final/gi, "Cuartos")
    .replace(/Semi-final/gi, "Semifinal")
    .replace(/Match for third place/gi, "Tercer Puesto")
    .replace(/Final/gi, "Final");
};

const getTzAbbreviation = () => {
  try {
    return Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(new Date())
      .find(part => part.type === 'timeZoneName')?.value || "";
  } catch (e) {
    return "";
  }
};

const capitalizeFirstLetter = (str: string) => {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
};

const getPointsBadgeClass = (points: number, isOldMatch: boolean): string => {
  if (isOldMatch) {
    if (points === 1) {
      return "bg-amber-500/10 text-amber-400 border border-amber-500/20";
    }
    return "bg-slate-800 text-slate-500 border border-transparent";
  } else {
    switch (points) {
      case 5:
        return "bg-amber-500/10 text-amber-400 border border-amber-500/20";
      case 3:
        return "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20";
      case 1:
        return "bg-blue-500/10 text-blue-400 border border-blue-500/20";
      default:
        return "bg-slate-800 text-slate-500 border border-transparent";
    }
  }
};

export default function Home() {
  const {
    user,
    profile,
    loading,
    savedAccounts,
    login,
    signup,
    logout,
    switchAccount,
    removeSavedAccount,
    sendPasswordReset
  } = useAuth();

  // Auth state inputs
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [resetEmailSent, setResetEmailSent] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  // Tabs: 'matches', 'leaderboard', 'admin'
  const [activeTab, setActiveTab] = useState<"matches" | "leaderboard" | "admin">("matches");

  // Leaderboard Phase: 'new' (from June 13 onwards), 'old' (up to June 12)
  const [leaderboardPhase, setLeaderboardPhase] = useState<"new" | "old">("new");

  // Data lists
  const [matches, setMatches] = useState<Match[]>([]);
  const [predictions, setPredictions] = useState<{ [matchId: string]: Prediction }>({});
  const [allPredictions, setAllPredictions] = useState<Prediction[]>([]);
  const [leaderboard, setLeaderboard] = useState<UserProfile[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  // Filter & prediction draft inputs
  const [selectedRound, setSelectedRound] = useState<string>("Todos");
  const [hidePastMatches, setHidePastMatches] = useState(true);
  const [predictionDrafts, setPredictionDrafts] = useState<{ [matchId: string]: { goals1: string; goals2: string } }>({});
  const [savingMatches, setSavingMatches] = useState<{ [matchId: string]: boolean }>({});

  // Admin inputs
  const [adminResults, setAdminResults] = useState<{ [matchId: string]: { goals1: string; goals2: string; isFinal: boolean } }>({});
  const [adminSaving, setAdminSaving] = useState<{ [matchId: string]: boolean }>({});
  const [adminSubTab, setAdminSubTab] = useState<"results" | "predictions" | "users">("results");
  const [adminSelectedUserId, setAdminSelectedUserId] = useState<string>("");
  const [adminUserPredictions, setAdminUserPredictions] = useState<{ [matchId: string]: Prediction }>({});
  const [adminUserDrafts, setAdminUserDrafts] = useState<{ [matchId: string]: { goals1: string; goals2: string } }>({});
  const [adminSavingUserPreds, setAdminSavingUserPreds] = useState<{ [matchId: string]: boolean }>({});
  const [adminRecalculating, setAdminRecalculating] = useState(false);
  const [hidePastMatchesAdmin, setHidePastMatchesAdmin] = useState(true);

  // User Management State
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [editUserDraft, setEditUserDraft] = useState<{
    displayName: string;
    email: string;
    points: string;
    previousPoints: string;
    isAdmin: boolean;
  } | null>(null);
  const [adminDeletingUser, setAdminDeletingUser] = useState<{ [uid: string]: boolean }>({});
  const [adminSavingUser, setAdminSavingUser] = useState(false);

  // Match sync state
  const [matchesSyncing, setMatchesSyncing] = useState(false);
  const [lastMatchesUpdate, setLastMatchesUpdate] = useState<number | null>(null);
  const [syncCooldown, setSyncCooldown] = useState(0);
  const [refreshingMatches, setRefreshingMatches] = useState<{ [matchId: string]: boolean }>({});

  // View user predictions modal states
  const [viewingUser, setViewingUser] = useState<UserProfile | null>(null);
  const [viewingUserFilter, setViewingUserFilter] = useState<"started" | "all">("started");

  // View team history modal states
  const [selectedTeamHistory, setSelectedTeamHistory] = useState<string | null>(null);

  // Auth Handlers
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      if (isRegistering) {
        if (!name.trim()) {
          throw new Error("El nombre es obligatorio");
        }
        await signup(email, password, name.trim());
      } else {
        await login(email, password);
      }
    } catch (err: any) {
      console.error(err);
      let msg = "Ocurrió un error. Revisa tus credenciales.";
      if (err.code === "auth/email-already-in-use") msg = "El correo ya está registrado.";
      if (err.code === "auth/invalid-credential") msg = "Correo o contraseña incorrectos.";
      if (err.code === "auth/weak-password") msg = "La contraseña debe tener al menos 6 caracteres.";
      setAuthError(err.message || msg);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthLoading(true);
    try {
      if (!email.trim()) {
        throw new Error("El correo es obligatorio");
      }
      await sendPasswordReset(email.trim());
      setResetEmailSent(true);
    } catch (err: any) {
      console.error(err);
      let msg = "Ocurrió un error al enviar el correo.";
      if (err.code === "auth/invalid-email") msg = "El correo no es válido.";
      if (err.code === "auth/user-not-found") msg = "No existe un usuario con este correo.";
      setAuthError(err.message || msg);
    } finally {
      setAuthLoading(false);
    }
  };

  // Real-time data sync
  useEffect(() => {
    if (!user) return;

    setDataLoading(true);
    setPredictions({});
    setPredictionDrafts({});

    // 1. Sync Matches (segmented cache: archived 24h TTL, active 5-min TTL)
    const loadMatches = async () => {
      const todayStr = (() => {
        const t = new Date();
        return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
      })();

      const ARCHIVED_TTL = 24 * 60 * 60 * 1000; // 24h — past days never change
      const ACTIVE_TTL   =  5 * 60 * 1000;       // 5 min — today's live scores

      let archivedMatches: Match[] | null = null;
      let activeMatches: Match[]   | null = null;
      let archivedCacheTime = 0;
      let activeCacheTime = 0;

      try {
        const str  = localStorage.getItem("polla_archived_cache");
        const time = localStorage.getItem("polla_archived_cache_time");
        if (str && time && (Date.now() - parseInt(time, 10)) <= ARCHIVED_TTL) {
          const parsed = JSON.parse(str) as Match[];
          archivedMatches = Array.from(new Map(parsed.map(m => [m.id, m])).values());
          archivedCacheTime = parseInt(time, 10);
        }
      } catch (e) { console.error("Error reading archived cache:", e); }

      try {
        const str  = localStorage.getItem("polla_active_cache");
        const time = localStorage.getItem("polla_active_cache_time");
        if (str && time) {
          const parsedTime = parseInt(time, 10);
          if ((Date.now() - parsedTime) <= ACTIVE_TTL) {
            const parsed = JSON.parse(str) as Match[];
            activeMatches = Array.from(new Map(parsed.map(m => [m.id, m])).values());
            activeCacheTime = parsedTime;
          }
        }
      } catch (e) { console.error("Error reading active cache:", e); }

      // Check server version if we have cached data
      if (archivedMatches || activeMatches) {
        try {
          const versionSnap = await getDoc(doc(db, "meta", "matches_version"));
          const serverUpdatedAt: number = versionSnap.exists() ? (versionSnap.data().updatedAt ?? 0) : 0;
          
          if (archivedMatches && archivedCacheTime < serverUpdatedAt) {
            archivedMatches = null; // Stale archived matches
          }
          if (activeMatches && activeCacheTime < serverUpdatedAt) {
            activeMatches = null; // Stale active matches
          }
        } catch (e) {
          console.warn("Could not check matches_version:", e);
        }
      }

      // If both caches are valid (either initially or after version check)
      if (archivedMatches && activeMatches) {
        const merged = Array.from(new Map([...archivedMatches, ...activeMatches].map(m => [m.id, m])).values()).sort((a, b) => a.num - b.num);
        setMatches(merged);
        setAdminResults(prev => {
          const drafts: typeof prev = {};
          merged.forEach(m => {
            drafts[m.id] = m.result
              ? { goals1: String(m.result.goals1), goals2: String(m.result.goals2), isFinal: m.result.isFinal ?? true }
              : { goals1: "", goals2: "", isFinal: true };
          });
          return { ...drafts, ...prev };
        });
        setLastMatchesUpdate(activeCacheTime);
        return;
      }

      setMatchesSyncing(true);
      try {
        if (archivedMatches) {
          // Only fetch today + future
          const qTodayPlus = query(collection(db, "matches"), orderBy("date", "asc"), orderBy("num", "asc"));
          const snapActive = await getDocs(qTodayPlus);
          const freshActive: Match[] = [];
          snapActive.forEach((d) => {
            const m = d.data() as Match;
            if (m.date >= todayStr) freshActive.push({ ...m, id: d.id });
          });
          freshActive.sort((a, b) => a.num - b.num);

          // Move today's finalized matches into archived cache (stable, no need to re-fetch every 5min)
          const todayFinal = freshActive.filter(m => m.date === todayStr && m.result !== null && m.result.isFinal !== false);
          const stillActive = freshActive.filter(m => !(m.date === todayStr && m.result !== null && m.result.isFinal !== false));
          const updatedArchived = Array.from(
            new Map([...archivedMatches, ...todayFinal].map(m => [m.id, m])).values()
          ).sort((a, b) => a.num - b.num);

          const now = Date.now();
          if (todayFinal.length > 0) {
            localStorage.setItem("polla_archived_cache",      JSON.stringify(updatedArchived));
            localStorage.setItem("polla_archived_cache_time", String(now));
          }
          localStorage.setItem("polla_active_cache", JSON.stringify(stillActive));
          localStorage.setItem("polla_active_cache_time", String(now));
          setLastMatchesUpdate(now);

          const merged = Array.from(new Map([...updatedArchived, ...stillActive].map(m => [m.id, m])).values()).sort((a, b) => a.num - b.num);
          setMatches(merged);
          const drafts: typeof adminResults = {};
          merged.forEach(m => {
            drafts[m.id] = m.result
              ? { goals1: String(m.result.goals1), goals2: String(m.result.goals2), isFinal: m.result.isFinal ?? true }
              : { goals1: "", goals2: "", isFinal: true };
          });
          setAdminResults(prev => ({ ...drafts, ...prev }));
        } else {
          // Full fetch
          const qAll = query(collection(db, "matches"), orderBy("num", "asc"));
          const snap = await getDocs(qAll);
          const all: Match[] = [];
          const adminDrafts: { [matchId: string]: { goals1: string; goals2: string; isFinal: boolean } } = {};
          snap.forEach((d) => {
            const m = d.data() as Match;
            all.push({ ...m, id: d.id });
            adminDrafts[d.id] = m.result
              ? { goals1: String(m.result.goals1), goals2: String(m.result.goals2), isFinal: m.result.isFinal ?? true }
              : { goals1: "", goals2: "", isFinal: true };
          });

          // Archive past days + today's finalized matches (stable)
          const archived = all.filter(m => m.date < todayStr || (m.date === todayStr && m.result !== null && m.result.isFinal !== false));
          const active   = all.filter(m => !(m.date < todayStr || (m.date === todayStr && m.result !== null && m.result.isFinal !== false)));
          const now = Date.now();
          localStorage.setItem("polla_archived_cache",      JSON.stringify(archived));
          localStorage.setItem("polla_archived_cache_time", String(now));
          localStorage.setItem("polla_active_cache",        JSON.stringify(active));
          localStorage.setItem("polla_active_cache_time",   String(now));
          setLastMatchesUpdate(now);
          setMatches(all);
          setAdminResults(prev => ({ ...adminDrafts, ...prev }));
        }
      } catch (err) {
        console.error("Error fetching matches:", err);
      } finally {
        setMatchesSyncing(false);
      }
    };
    loadMatches();

    // 2. Sync Current User's Predictions
    const qPreds = query(collection(db, "predictions"));
    const unsubPreds = onSnapshot(qPreds, (snapshot) => {
      const userPreds: { [matchId: string]: Prediction } = {};
      const allPredsList: Prediction[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data() as Prediction;
        allPredsList.push(data);
        if (data.userId === user.uid) {
          userPreds[data.matchId] = data;
        }
      });
      setPredictions(userPreds);
      setAllPredictions(allPredsList);

      // Initialize prediction drafts with existing values
      const drafts: { [matchId: string]: { goals1: string; goals2: string } } = {};
      allPredsList.forEach((data) => {
        if (data.userId === user.uid) {
          drafts[data.matchId] = {
            goals1: String(data.goals1),
            goals2: String(data.goals2),
          };
        }
      });
      setPredictionDrafts(drafts);
    });

    // 3. Sync Leaderboard / Users
    const qUsers = query(collection(db, "users"), orderBy("points", "desc"));
    const unsubUsers = onSnapshot(qUsers, (snapshot) => {
      const list: UserProfile[] = [];
      snapshot.forEach((doc) => {
        list.push(doc.data() as UserProfile);
      });
      setLeaderboard(list);
      setDataLoading(false);
    });

    return () => {
      unsubPreds();
      unsubUsers();
    };
  }, [user]);

  // Sync selected user's predictions for admin edit
  useEffect(() => {
    if (!user || !profile?.isAdmin || !adminSelectedUserId) {
      setAdminUserPredictions({});
      setAdminUserDrafts({});
      return;
    }

    const qPreds = query(collection(db, "predictions"));
    const unsubAdminUserPreds = onSnapshot(qPreds, (snapshot) => {
      const userPreds: { [matchId: string]: Prediction } = {};
      const drafts: { [matchId: string]: { goals1: string; goals2: string } } = {};

      snapshot.forEach((doc) => {
        const data = doc.data() as Prediction;
        if (data.userId === adminSelectedUserId) {
          userPreds[data.matchId] = data;
          drafts[data.matchId] = {
            goals1: String(data.goals1),
            goals2: String(data.goals2),
          };
        }
      });

      setAdminUserPredictions(userPreds);
      setAdminUserDrafts(drafts);
    });

    return () => {
      unsubAdminUserPreds();
    };
  }, [user, profile?.isAdmin, adminSelectedUserId]);

  const saveUserPredictionByAdmin = async (matchId: string) => {
    if (!user || !profile?.isAdmin || !adminSelectedUserId) return;
    const draft = adminUserDrafts[matchId];
    if (!draft || draft.goals1 === "" || draft.goals2 === "") return;

    const g1 = parseInt(draft.goals1);
    const g2 = parseInt(draft.goals2);
    if (isNaN(g1) || isNaN(g2)) return;

    setAdminSavingUserPreds(prev => ({ ...prev, [matchId]: true }));
    try {
      const predId = `${adminSelectedUserId}_${matchId}`;
      const match = matches.find(m => m.id === matchId);

      let pts = 0;
      if (match?.result) {
        pts = (match.date < "2026-06-13")
          ? calculatePointsOld(g1, g2, match.result.goals1, match.result.goals2)
          : calculatePointsNew(g1, g2, match.result.goals1, match.result.goals2);
      }

      await setDoc(doc(db, "predictions", predId), {
        id: predId,
        userId: adminSelectedUserId,
        matchId: matchId,
        goals1: g1,
        goals2: g2,
        points: pts
      });

      const allPredsSnap = await getDocs(collection(db, "predictions"));
      const matchesSnap = await getDocs(collection(db, "matches"));
      const matchesMap: { [id: string]: Match } = {};
      matchesSnap.forEach(d => {
        matchesMap[d.id] = { ...d.data() as Match, id: d.id };
      });

      let totalPoints = 0;
      let totalPreviousPoints = 0;
      allPredsSnap.forEach((pDoc) => {
        const pred = pDoc.data() as Prediction;
        if (pred.userId === adminSelectedUserId) {
          const m = matchesMap[pred.matchId];
          if (m && m.date < "2026-06-13") {
            totalPreviousPoints += pred.points || 0;
          } else {
            totalPoints += pred.points || 0;
          }
        }
      });

      await setDoc(doc(db, "users", adminSelectedUserId), {
        points: totalPoints,
        previousPoints: totalPreviousPoints
      }, { merge: true });

    } catch (err) {
      console.error("Error saving user prediction by admin:", err);
      alert("Error al guardar la predicción del usuario.");
    } finally {
      setAdminSavingUserPreds(prev => ({ ...prev, [matchId]: false }));
    }
  };

  // Handle saving prediction
  const savePrediction = async (matchId: string) => {
    if (!user) return;
    const draft = predictionDrafts[matchId];
    if (!draft || draft.goals1 === "" || draft.goals2 === "") return;

    const g1 = parseInt(draft.goals1);
    const g2 = parseInt(draft.goals2);
    if (isNaN(g1) || isNaN(g2)) return;

    setSavingMatches(prev => ({ ...prev, [matchId]: true }));
    try {
      const predId = `${user.uid}_${matchId}`;
      const match = matches.find(m => m.id === matchId);

      let pts = 0;
      if (match?.result) {
        pts = (match.date < "2026-06-13")
          ? calculatePointsOld(g1, g2, match.result.goals1, match.result.goals2)
          : calculatePointsNew(g1, g2, match.result.goals1, match.result.goals2);
      }

      await setDoc(doc(db, "predictions", predId), {
        id: predId,
        userId: user.uid,
        matchId: matchId,
        goals1: g1,
        goals2: g2,
        points: pts
      });
    } catch (err) {
      console.error("Error saving prediction:", err);
    } finally {
      setSavingMatches(prev => ({ ...prev, [matchId]: false }));
    }
  };

  // Admin: Set Match Result and Update Scores
  const saveMatchResult = async (matchId: string) => {
    const draft = adminResults[matchId];
    if (!draft || draft.goals1 === "" || draft.goals2 === "") return;

    const rg1 = parseInt(draft.goals1);
    const rg2 = parseInt(draft.goals2);
    if (isNaN(rg1) || isNaN(rg2)) return;

    setAdminSaving(prev => ({ ...prev, [matchId]: true }));

    try {
      // 1. Update Match Doc
      const matchRef = doc(db, "matches", matchId);
      await setDoc(matchRef, {
        result: { goals1: rg1, goals2: rg2, isFinal: draft.isFinal ?? true }
      }, { merge: true });

      // 2. Fetch all predictions for this match
      const predSnap = await getDocs(collection(db, "predictions"));
      const batch = writeBatch(db);
      const updatedUserIds = new Set<string>();
      const match = matches.find(m => m.id === matchId);

      predSnap.forEach((pDoc) => {
        const pred = pDoc.data() as Prediction;
        if (pred.matchId === matchId) {
          const pts = (match && match.date < "2026-06-13")
            ? calculatePointsOld(pred.goals1, pred.goals2, rg1, rg2)
            : calculatePointsNew(pred.goals1, pred.goals2, rg1, rg2);
          batch.update(doc(db, "predictions", pred.id), { points: pts });
          updatedUserIds.add(pred.userId);
        }
      });

      // Commit predictions updates
      await batch.commit();

      // 3. Recalculate users points
      const allPredsSnap = await getDocs(collection(db, "predictions"));
      const matchesSnap = await getDocs(collection(db, "matches"));
      const matchesMap: { [id: string]: Match } = {};
      matchesSnap.forEach(d => {
        matchesMap[d.id] = { ...d.data() as Match, id: d.id };
      });

      const userPointsMap: { [userId: string]: number } = {};
      const userPreviousPointsMap: { [userId: string]: number } = {};

      allPredsSnap.forEach((pDoc) => {
        const pred = pDoc.data() as Prediction;
        const m = matchesMap[pred.matchId];
        if (m && m.date < "2026-06-13") {
          if (!userPreviousPointsMap[pred.userId]) {
            userPreviousPointsMap[pred.userId] = 0;
          }
          userPreviousPointsMap[pred.userId] += pred.points || 0;
        } else {
          if (!userPointsMap[pred.userId]) {
            userPointsMap[pred.userId] = 0;
          }
          userPointsMap[pred.userId] += pred.points || 0;
        }
      });

      // Update users collection
      const userBatch = writeBatch(db);
      const usersSnap = await getDocs(collection(db, "users"));
      usersSnap.forEach(uDoc => {
        const uid = uDoc.id;
        const pts = userPointsMap[uid] || 0;
        const prevPts = userPreviousPointsMap[uid] || 0;
        userBatch.set(doc(db, "users", uid), { points: pts, previousPoints: prevPts }, { merge: true });
      });
      await userBatch.commit();

      // Notify clients their active cache is stale
      await setDoc(doc(db, "meta", "matches_version"), { updatedAt: Date.now() }, { merge: true });

      alert("Resultado guardado y puntajes recalculados exitosamente.");
    } catch (err) {
      console.error("Error setting match result:", err);
      alert("Error al guardar resultado.");
    } finally {
      setAdminSaving(prev => ({ ...prev, [matchId]: false }));
    }
  };

  // Refresh live match score by matchId (to save Firestore reads)
  const refreshLiveMatchScore = async (matchId: string) => {
    if (refreshingMatches[matchId]) return;
    setRefreshingMatches(prev => ({ ...prev, [matchId]: true }));
    try {
      const matchSnap = await getDoc(doc(db, "matches", matchId));
      if (matchSnap.exists()) {
        const freshMatchData = { ...matchSnap.data(), id: matchSnap.id } as Match;

        // 1. Update React state
        setMatches(prevMatches =>
          prevMatches.map(m => (m.id === matchId ? freshMatchData : m))
        );

        // 2. Sync local storage caches to keep client in sync
        try {
          const archivedStr = localStorage.getItem("polla_archived_cache");
          const activeStr = localStorage.getItem("polla_active_cache");
          const todayStr = (() => {
            const t = new Date();
            return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
          })();

          const isFinal = freshMatchData.result !== null && freshMatchData.result.isFinal !== false;
          const isArchived = freshMatchData.date < todayStr || (freshMatchData.date === todayStr && isFinal);

          if (archivedStr) {
            let archived = JSON.parse(archivedStr) as Match[];
            if (isArchived) {
              if (archived.some(m => m.id === matchId)) {
                archived = archived.map(m => (m.id === matchId ? freshMatchData : m));
              } else {
                archived.push(freshMatchData);
              }
            } else {
              archived = archived.filter(m => m.id !== matchId);
            }
            localStorage.setItem("polla_archived_cache", JSON.stringify(archived));
          }

          if (activeStr) {
            let active = JSON.parse(activeStr) as Match[];
            if (!isArchived) {
              if (active.some(m => m.id === matchId)) {
                active = active.map(m => (m.id === matchId ? freshMatchData : m));
              } else {
                active.push(freshMatchData);
              }
            } else {
              active = active.filter(m => m.id !== matchId);
            }
            localStorage.setItem("polla_active_cache", JSON.stringify(active));
          }
        } catch (e) {
          console.error("Error updating local storage cache for single match:", e);
        }
      }
    } catch (err) {
      console.error("Error refreshing match score:", err);
    } finally {
      setRefreshingMatches(prev => ({ ...prev, [matchId]: false }));
    }
  };

  // Manual force-sync for users (30s cooldown)
  const forceSyncMatches = async () => {
    if (matchesSyncing) return;
    try {
      const lastSync = localStorage.getItem("polla_last_manual_sync");
      if (lastSync && (Date.now() - parseInt(lastSync, 10)) < 30000) {
        const remaining = Math.ceil((30000 - (Date.now() - parseInt(lastSync, 10))) / 1000);
        alert(`Por favor espera ${remaining} segundos antes de sincronizar nuevamente.`);
        return;
      }
    } catch (e) { /* ignore */ }

    const todayStr = (() => {
      const t = new Date();
      return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    })();

    setMatchesSyncing(true);
    try {
      const qAll = query(collection(db, "matches"), orderBy("num", "asc"));
      const snap = await getDocs(qAll);
      const all: Match[] = [];
      const adminDrafts: { [id: string]: { goals1: string; goals2: string; isFinal: boolean } } = {};
      snap.forEach((d) => {
        const m = d.data() as Match;
        all.push({ ...m, id: d.id });
        adminDrafts[d.id] = m.result
          ? { goals1: String(m.result.goals1), goals2: String(m.result.goals2), isFinal: m.result.isFinal ?? true }
          : { goals1: "", goals2: "", isFinal: true };
      });
      // Archive past days + today's finalized matches (stable)
      const archived = all.filter(m => m.date < todayStr || (m.date === todayStr && m.result !== null && m.result.isFinal !== false));
      const active   = all.filter(m => !(m.date < todayStr || (m.date === todayStr && m.result !== null && m.result.isFinal !== false)));
      const now = Date.now();
      localStorage.setItem("polla_archived_cache",      JSON.stringify(archived));
      localStorage.setItem("polla_archived_cache_time", String(now));
      localStorage.setItem("polla_active_cache",        JSON.stringify(active));
      localStorage.setItem("polla_active_cache_time",   String(now));
      localStorage.setItem("polla_last_manual_sync",    String(now));
      setMatches(all);
      setAdminResults(prev => ({ ...adminDrafts, ...prev }));
      setLastMatchesUpdate(now);
    } catch (err) {
      console.error("Error force-syncing matches:", err);
    } finally {
      setMatchesSyncing(false);
    }
  };

  const recalculateAllScores = async () => {
    if (adminRecalculating) return;
    const confirmRecalc = window.confirm("¿Estás seguro de que deseas recalcular y actualizar en la base de datos los puntos de todos los usuarios y predicciones? Esto resolverá cualquier descuadre.");
    if (!confirmRecalc) return;

    setAdminRecalculating(true);
    try {
      const matchesSnap = await getDocs(collection(db, "matches"));
      const predsSnap = await getDocs(collection(db, "predictions"));

      const matchesMap: { [id: string]: Match } = {};
      matchesSnap.forEach(doc => {
        matchesMap[doc.id] = { ...doc.data() as Match, id: doc.id };
      });

      const userPointsMap: { [userId: string]: number } = {};
      const userPreviousPointsMap: { [userId: string]: number } = {};
      const batch = writeBatch(db);

      predsSnap.forEach(pDoc => {
        const pred = pDoc.data() as Prediction;
        const match = matchesMap[pred.matchId];

        let pts = 0;
        if (match && match.result) {
          pts = (match.date < "2026-06-13")
            ? calculatePointsOld(pred.goals1, pred.goals2, match.result.goals1, match.result.goals2)
            : calculatePointsNew(pred.goals1, pred.goals2, match.result.goals1, match.result.goals2);
        }

        if (pred.points !== pts) {
          batch.update(doc(db, "predictions", pred.id), { points: pts });
        }

        if (match && match.date < "2026-06-13") {
          if (!userPreviousPointsMap[pred.userId]) {
            userPreviousPointsMap[pred.userId] = 0;
          }
          userPreviousPointsMap[pred.userId] += pts;
        } else {
          if (!userPointsMap[pred.userId]) {
            userPointsMap[pred.userId] = 0;
          }
          userPointsMap[pred.userId] += pts;
        }
      });

      const usersSnap = await getDocs(collection(db, "users"));
      usersSnap.forEach(uDoc => {
        const uid = uDoc.id;
        const pts = userPointsMap[uid] || 0;
        const prevPts = userPreviousPointsMap[uid] || 0;
        batch.set(doc(db, "users", uid), { points: pts, previousPoints: prevPts }, { merge: true });
      });

      await batch.commit();
      alert("¡Todos los puntajes de las predicciones y de los usuarios (anteriores y nuevos) han sido recalculados y guardados con éxito en la base de datos!");
    } catch (err) {
      console.error("Error recalculating all scores:", err);
      alert("Error al recalcular todos los puntajes en Firestore.");
    } finally {
      setAdminRecalculating(false);
    }
  };

  const deleteUserByAdmin = async (uid: string, displayName: string) => {
    if (!user || !profile?.isAdmin) return;
    const confirmDelete = window.confirm(`¿Estás seguro de que deseas eliminar permanentemente a "${displayName}" y todos sus pronósticos? Esta acción no se puede deshacer.`);
    if (!confirmDelete) return;

    setAdminDeletingUser(prev => ({ ...prev, [uid]: true }));
    try {
      // 1. Fetch all predictions
      const predsSnap = await getDocs(collection(db, "predictions"));
      const batch = writeBatch(db);

      let deleteCount = 0;
      predsSnap.forEach((pDoc) => {
        const pred = pDoc.data() as Prediction;
        if (pred.userId === uid) {
          batch.delete(doc(db, "predictions", pDoc.id));
          deleteCount++;
        }
      });

      // 2. Delete user doc
      batch.delete(doc(db, "users", uid));

      // 3. Commit
      await batch.commit();
      alert(`El usuario "${displayName}" ha sido eliminado exitosamente junto con sus ${deleteCount} pronósticos.`);
    } catch (err) {
      console.error("Error deleting user:", err);
      alert("Error al eliminar el usuario y sus pronósticos.");
    } finally {
      setAdminDeletingUser(prev => ({ ...prev, [uid]: false }));
    }
  };

  const saveUserEditByAdmin = async () => {
    if (!user || !profile?.isAdmin || !editingUser || !editUserDraft) return;

    const { displayName, email, points, previousPoints, isAdmin } = editUserDraft;
    if (!displayName.trim() || !email.trim()) {
      alert("El nombre y el correo son obligatorios.");
      return;
    }

    const pts = parseInt(points);
    const prevPts = parseInt(previousPoints);
    if (isNaN(pts) || isNaN(prevPts)) {
      alert("Los puntos deben ser valores numéricos.");
      return;
    }

    setAdminSavingUser(true);
    try {
      const userRef = doc(db, "users", editingUser.uid);
      await setDoc(userRef, {
        displayName: displayName.trim(),
        email: email.trim(),
        points: pts,
        previousPoints: prevPts,
        isAdmin: isAdmin
      }, { merge: true });

      alert("Datos del usuario actualizados exitosamente.");
      setEditingUser(null);
      setEditUserDraft(null);
    } catch (err) {
      console.error("Error updating user:", err);
      alert("Error al actualizar la información del usuario.");
    } finally {
      setAdminSavingUser(false);
    }
  };

  // Compute financial metrics dynamically in real-time
  const financialStats = React.useMemo(() => {
    const sortedMatches = [...matches].sort((a, b) => a.num - b.num);

    const statsOld: {
      [userId: string]: {
        invested: number;
        winnings: number;
        balance: number;
        predictionsCount: number;
      }
    } = {};

    const statsNew: {
      [userId: string]: {
        invested: number;
        winnings: number;
        balance: number;
        predictionsCount: number;
      }
    } = {};

    // Ensure all users in leaderboard are initialized
    leaderboard.forEach(u => {
      statsOld[u.uid] = { invested: 0, winnings: 0, balance: 0, predictionsCount: 0 };
      statsNew[u.uid] = { invested: 0, winnings: 0, balance: 0, predictionsCount: 0 };
    });

    let rolloverOld = 0;
    let rolloverNew = 0;

    sortedMatches.forEach(match => {
      if (!match.result || match.result.isFinal === false) return;

      const matchPreds = allPredictions.filter(p => p.matchId === match.id);
      if (matchPreds.length === 0) return;

      const isOld = match.date < "2026-06-13";
      const stats = isOld ? statsOld : statsNew;

      matchPreds.forEach(pred => {
        if (!stats[pred.userId]) {
          stats[pred.userId] = { invested: 0, winnings: 0, balance: 0, predictionsCount: 0 };
        }
        stats[pred.userId].predictionsCount += 1;
        stats[pred.userId].invested += 500;
      });

      if (isOld) {
        const totalPoolForMatch = (matchPreds.length * 500) + rolloverOld;
        const winners = matchPreds.filter(pred =>
          pred.goals1 === match.result!.goals1 && pred.goals2 === match.result!.goals2
        );
        if (winners.length > 0) {
          const winAmountPerUser = totalPoolForMatch / winners.length;
          winners.forEach(winner => {
            statsOld[winner.userId].winnings += winAmountPerUser;
          });
          rolloverOld = 0;
        } else {
          rolloverOld = totalPoolForMatch;
        }
      } else {
        const totalPoolForMatch = (matchPreds.length * 500) + rolloverNew;
        const winners = matchPreds.filter(pred =>
          pred.goals1 === match.result!.goals1 && pred.goals2 === match.result!.goals2
        );
        if (winners.length > 0) {
          const winAmountPerUser = totalPoolForMatch / winners.length;
          winners.forEach(winner => {
            statsNew[winner.userId].winnings += winAmountPerUser;
          });
          rolloverNew = 0;
        } else {
          rolloverNew = totalPoolForMatch;
        }
      }
    });

    Object.keys(statsOld).forEach(uid => {
      statsOld[uid].balance = statsOld[uid].winnings - statsOld[uid].invested;
    });
    Object.keys(statsNew).forEach(uid => {
      statsNew[uid].balance = statsNew[uid].winnings - statsNew[uid].invested;
    });

    return {
      statsOld,
      statsNew,
      rolloverOld,
      rolloverNew,
      // Fallbacks for header compatibility
      stats: statsNew,
      currentRollover: rolloverNew
    };
  }, [matches, allPredictions, leaderboard]);

  // Calculate points dynamically in real-time to guarantee correctness and avoid database mismatches
  const calculatedPoints = React.useMemo(() => {
    const pointsMap: {
      [userId: string]: {
        pointsOld: number;
        pointsNew: number;
      }
    } = {};

    // Initialize all users in leaderboard
    leaderboard.forEach(u => {
      pointsMap[u.uid] = { pointsOld: 0, pointsNew: 0 };
    });

    const matchesMap: { [id: string]: Match } = {};
    matches.forEach(m => {
      matchesMap[m.id] = m;
    });

    allPredictions.forEach(pred => {
      const match = matchesMap[pred.matchId];
      if (match && match.result && match.result.isFinal !== false) {
        const isOld = match.date < "2026-06-13";
        const pts = isOld
          ? calculatePointsOld(pred.goals1, pred.goals2, match.result.goals1, match.result.goals2)
          : calculatePointsNew(pred.goals1, pred.goals2, match.result.goals1, match.result.goals2);

        if (!pointsMap[pred.userId]) {
          pointsMap[pred.userId] = { pointsOld: 0, pointsNew: 0 };
        }

        if (isOld) {
          pointsMap[pred.userId].pointsOld += pts;
        } else {
          pointsMap[pred.userId].pointsNew += pts;
        }
      }
    });

    return pointsMap;
  }, [matches, allPredictions, leaderboard]);

  // Sort leaderboard depending on the selected phase
  const sortedLeaderboard = React.useMemo(() => {
    return [...leaderboard].sort((a, b) => {
      const pointsA = calculatedPoints[a.uid] || { pointsOld: 0, pointsNew: 0 };
      const pointsB = calculatedPoints[b.uid] || { pointsOld: 0, pointsNew: 0 };

      if (leaderboardPhase === "new") {
        if (pointsB.pointsNew !== pointsA.pointsNew) {
          return pointsB.pointsNew - pointsA.pointsNew;
        }
        return pointsB.pointsOld - pointsA.pointsOld || a.displayName.localeCompare(b.displayName);
      } else {
        if (pointsB.pointsOld !== pointsA.pointsOld) {
          return pointsB.pointsOld - pointsA.pointsOld;
        }
        return pointsB.pointsNew - pointsA.pointsNew || a.displayName.localeCompare(b.displayName);
      }
    });
  }, [leaderboard, leaderboardPhase, calculatedPoints]);

  // Unique list of rounds for filtering
  const rounds = ["Todos", "Matchday 1", "Matchday 2", "Matchday 3", "Matchday 4", "Matchday 5", "Matchday 6", "Matchday 7", "Matchday 8", "Matchday 9", "Matchday 10", "Matchday 11", "Matchday 12", "Matchday 13", "Matchday 14", "Matchday 15", "Matchday 16", "Matchday 17", "Round of 32", "Round of 16", "Quarter-final", "Semi-final", "Match for third place", "Final"];

  const filteredMatches = selectedRound === "Todos"
    ? matches
    : matches.filter(m => m.round === selectedRound);

  const pastMatchesCount = React.useMemo(() => {
    return filteredMatches.filter(isMatchPast).length;
  }, [filteredMatches]);

  const userFilteredMatches = React.useMemo(() => {
    if (hidePastMatches) {
      return filteredMatches.filter(m => !isMatchPast(m));
    }
    return filteredMatches;
  }, [filteredMatches, hidePastMatches]);

  const adminFilteredMatches = React.useMemo(() => {
    if (hidePastMatchesAdmin) {
      return filteredMatches.filter(m => !isMatchPast(m));
    }
    return filteredMatches;
  }, [filteredMatches, hidePastMatchesAdmin]);

  const userGroupedMatches = React.useMemo(() => {
    const past    = userFilteredMatches.filter(m => isMatchPast(m));
    const upcoming = userFilteredMatches.filter(m => !isMatchPast(m));

    // Past: newest → oldest
    past.sort((a, b) => {
      const diff = getMatchDate(b).getTime() - getMatchDate(a).getTime();
      return diff !== 0 ? diff : b.num - a.num;
    });

    // Upcoming: oldest → newest
    upcoming.sort((a, b) => {
      const diff = getMatchDate(a).getTime() - getMatchDate(b).getTime();
      return diff !== 0 ? diff : a.num - b.num;
    });

    const buildGroups = (list: Match[], isPast: boolean) => {
      const groups: { [key: string]: Match[] } = {};
      const groupOrder: string[] = [];
      list.forEach((match) => {
        const matchDate = getMatchDate(match);
        const label = capitalizeFirstLetter(
          matchDate.toLocaleDateString(undefined, {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric"
          })
        );
        if (!groups[label]) {
          groups[label] = [];
          groupOrder.push(label);
        }
        groups[label].push(match);
      });
      return groupOrder.map(label => ({
        key: `${label}-${isPast ? "past" : "upcoming"}`,
        dateLabel: label,
        matches: groups[label]
      }));
    };

    return [...buildGroups(past, true), ...buildGroups(upcoming, false)];
  }, [userFilteredMatches]);

  const groupedMatches = React.useMemo(() => {
    const sorted = [...adminFilteredMatches].sort((a, b) => {
      const dateA = getMatchDate(a).getTime();
      const dateB = getMatchDate(b).getTime();
      if (dateA !== dateB) {
        return dateA - dateB;
      }
      return a.num - b.num;
    });

    const groups: { [key: string]: Match[] } = {};
    const groupOrder: string[] = [];

    sorted.forEach((match) => {
      const matchDate = getMatchDate(match);
      const label = capitalizeFirstLetter(
        matchDate.toLocaleDateString(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
          year: "numeric"
        })
      );
      if (!groups[label]) {
        groups[label] = [];
        groupOrder.push(label);
      }
      groups[label].push(match);
    });

    return groupOrder.map(label => ({
      key: label,
      dateLabel: label,
      matches: groups[label]
    }));
  }, [adminFilteredMatches]);

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-[#020804] text-white p-6">
        <div className="w-16 h-16 border-4 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-4 text-slate-400 font-medium animate-pulse">Cargando polla mundialista...</p>
      </div>
    );
  }

  // Not logged in: Show auth screen
  if (!user) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-[#041a0d] via-[#020804] to-black">
        <div className="w-full max-w-md bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 rounded-2xl shadow-2xl p-8 transition-all duration-300">
          <div className="text-center mb-8">
            <span className="text-5xl mb-2 block animate-bounce">🏆</span>
            <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-amber-400 via-yellow-300 to-sky-400 bg-clip-text text-transparent">
              Polla Mundial 2026
            </h1>
            <p className="text-amber-400 font-extrabold text-xs tracking-wider mt-1.5 uppercase">
              Familia Güiza • Ardila • Franco y otros jajaja
            </p>
            <p className="text-slate-400 text-sm mt-2">
              {isForgotPassword 
                ? "Recuperar contraseña" 
                : isRegistering 
                ? "Regístrate para pronosticar los 104 partidos" 
                : "Inicia sesión para ver tu puntaje y pronósticos"}
            </p>
          </div>

          {savedAccounts.length > 0 && !isRegistering && !isForgotPassword && (
            <div className="mb-6 border-b border-slate-800/60 pb-5">
              <span className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2.5">
                Ingresar con cuenta guardada:
              </span>
              <div className="space-y-2">
                {savedAccounts.map((acc) => (
                  <div
                    key={acc.email}
                    className="flex items-center justify-between p-2.5 bg-slate-950/40 hover:bg-slate-950/80 border border-slate-850 rounded-xl transition-all group"
                  >
                    <button
                      type="button"
                      onClick={async () => {
                        setAuthError("");
                        setAuthLoading(true);
                        try {
                          await switchAccount(acc.email);
                        } catch (err: any) {
                          setAuthError("No se pudo iniciar sesión de forma automática.");
                        } finally {
                          setAuthLoading(false);
                        }
                      }}
                      className="flex-1 text-left flex flex-col"
                    >
                      <span className="font-bold text-xs text-slate-200 group-hover:text-amber-400 transition-colors">
                        {acc.name}
                      </span>
                      <span className="text-[10px] text-slate-400 truncate max-w-[200px]">
                        {acc.email}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeSavedAccount(acc.email)}
                      className="text-slate-500 hover:text-rose-400 text-xs p-1 transition-colors"
                      title="Eliminar"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isForgotPassword ? (
            resetEmailSent ? (
              <div className="space-y-6 text-center">
                <div className="bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-sm px-4 py-5 rounded-xl">
                  <span className="text-3xl mb-2 block">📧</span>
                  <p className="font-bold text-base mb-1">¡Correo enviado!</p>
                  <p className="text-xs text-slate-400">
                    Hemos enviado un enlace a <strong className="text-emerald-400">{email}</strong> para restablecer tu contraseña. Revisa tu bandeja de entrada o spam.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setIsForgotPassword(false);
                    setResetEmailSent(false);
                    setAuthError("");
                  }}
                  className="w-full py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl active:scale-[0.98] transition-all duration-200"
                >
                  Volver a Iniciar Sesión
                </button>
              </div>
            ) : (
              <form onSubmit={handleResetSubmit} className="space-y-4">
                <p className="text-slate-450 text-xs text-center leading-relaxed">
                  Ingresa tu correo electrónico registrado y te enviaremos un enlace seguro para restablecer tu contraseña.
                </p>
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">Correo Electrónico</label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="usuario@correo.com"
                    required
                    className="w-full px-4 py-3 bg-slate-950/50 border border-slate-800 rounded-xl focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 text-slate-100 transition-colors"
                  />
                </div>

                {authError && (
                  <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm px-4 py-3 rounded-xl">
                    ⚠️ {authError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={authLoading}
                  className="w-full py-3 bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-450 text-slate-950 font-bold rounded-xl shadow-lg hover:shadow-amber-500/20 active:scale-[0.98] transition-all duration-200 flex items-center justify-center disabled:opacity-50"
                >
                  {authLoading ? (
                    <div className="w-5 h-5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
                  ) : (
                    "Enviar Enlace de Recuperación"
                  )}
                </button>

                <div className="text-center pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsForgotPassword(false);
                      setAuthError("");
                    }}
                    className="text-amber-400 hover:text-amber-300 text-xs font-semibold transition-colors"
                  >
                    ← Volver a Iniciar Sesión
                  </button>
                </div>
              </form>
            )
          ) : (
            <form onSubmit={handleAuthSubmit} className="space-y-4">
              {isRegistering && (
                <div>
                  <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">Nombre Completo</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Ej. Santiago Barrera"
                    required
                    className="w-full px-4 py-3 bg-slate-950/50 border border-slate-800 rounded-xl focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 text-slate-100 transition-colors"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">Correo Electrónico</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="usuario@correo.com"
                  required
                  className="w-full px-4 py-3 bg-slate-950/50 border border-slate-800 rounded-xl focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 text-slate-100 transition-colors"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">Contraseña</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="******"
                  required
                  className="w-full px-4 py-3 bg-slate-950/50 border border-slate-800 rounded-xl focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 text-slate-100 transition-colors"
                />
              </div>

              {!isRegistering && (
                <div className="text-right">
                  <button
                    type="button"
                    onClick={() => {
                      setIsForgotPassword(true);
                      setAuthError("");
                    }}
                    className="text-amber-400/80 hover:text-amber-300 text-xs font-semibold transition-colors"
                  >
                    ¿Olvidaste tu contraseña?
                  </button>
                </div>
              )}

              {authError && (
                <div className="bg-rose-500/10 border border-rose-500/30 text-rose-300 text-sm px-4 py-3 rounded-xl">
                  ⚠️ {authError}
                </div>
              )}

              <button
                type="submit"
                disabled={authLoading}
                className="w-full py-3 bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-400 hover:to-yellow-450 text-slate-950 font-bold rounded-xl shadow-lg hover:shadow-amber-500/20 active:scale-[0.98] transition-all duration-200 flex items-center justify-center disabled:opacity-50"
              >
                {authLoading ? (
                  <div className="w-5 h-5 border-2 border-slate-950 border-t-transparent rounded-full animate-spin"></div>
                ) : isRegistering ? (
                  "Crear Cuenta"
                ) : (
                  "Ingresar"
                )}
              </button>
            </form>
          )}

          <div className="mt-6 text-center">
            <button
              onClick={() => {
                setIsRegistering(!isRegistering);
                setIsForgotPassword(false);
                setAuthError("");
              }}
              className="text-amber-400 hover:text-amber-300 text-sm font-medium transition-colors"
            >
              {isForgotPassword
                ? "¿Ya tienes cuenta? Inicia Sesión"
                : isRegistering
                ? "¿Ya tienes cuenta? Inicia Sesión"
                : "¿No tienes cuenta? Regístrate aquí"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Logged in user dashboard
  return (
    <div className="flex-1 flex flex-col bg-gradient-to-b from-[#020804] via-[#010603] to-black min-h-screen overflow-x-hidden">
      {/* Header */}
      <header className="bg-slate-900/40 backdrop-blur-md border-b border-slate-900 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="text-2xl">🏆</span>
            <div className="hidden sm:flex flex-col">
              <span className="font-extrabold text-base sm:text-lg bg-gradient-to-r from-amber-400 via-yellow-300 to-sky-400 bg-clip-text text-transparent leading-none">
                Polla Mundial 2026
              </span>
              <span className="text-[10px] text-amber-400 font-bold uppercase tracking-wider mt-0.5 leading-none">
                Güiza • Ardila • Franco y otros jajaja
              </span>
            </div>
          </div>

          <div className="flex items-center space-x-4">
            <div className="hidden sm:flex flex-col text-right">
              <span className="text-xs text-slate-400">Jugador</span>
              <span className="font-semibold text-slate-200">{profile?.displayName}</span>
            </div>

            <div className="flex items-center space-x-2">
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-full px-4 py-1.5 flex items-center space-x-1.5">
                <span className="text-amber-400 font-bold">⭐</span>
                <span className="font-extrabold text-amber-400 text-sm">
                  {calculatedPoints[user.uid]?.pointsNew ?? 0} Pts
                  {calculatedPoints[user.uid] && calculatedPoints[user.uid].pointsOld > 0 && (
                    <span className="text-[10px] text-slate-400 ml-1.5 font-normal">
                      (Ant: {calculatedPoints[user.uid].pointsOld})
                    </span>
                  )}
                </span>
              </div>

              {user && financialStats.stats[user.uid] && (
                <div className="hidden md:flex items-center space-x-3 bg-slate-900/60 border border-slate-800 rounded-full px-4 py-1.5 text-[11px] text-slate-350">
                  <span>Debe aportar: <strong className="text-slate-200">${financialStats.stats[user.uid].invested} COP</strong></span>
                  <span className="text-slate-700">|</span>
                  <span>Premios Ganados: <strong className="text-amber-400">${financialStats.stats[user.uid].winnings.toFixed(0)} COP</strong></span>
                </div>
              )}
            </div>

            {savedAccounts.filter(acc => acc.email !== user?.email).length > 0 && (
              <select
                onChange={async (e) => {
                  if (e.target.value) {
                    try {
                      await switchAccount(e.target.value);
                    } catch (err) {
                      alert("Error al cambiar de cuenta");
                    }
                  }
                  e.target.value = "";
                }}
                className="px-2.5 py-1.5 bg-slate-850 hover:bg-slate-800 text-slate-300 text-xs font-semibold rounded-lg border border-slate-750 focus:outline-none cursor-pointer"
                defaultValue=""
              >
                <option value="" disabled>Cambiar Cuenta</option>
                {savedAccounts.filter(acc => acc.email !== user?.email).map(acc => (
                  <option key={acc.email} value={acc.email}>
                    {acc.name}
                  </option>
                ))}
              </select>
            )}

            <button
              onClick={logout}
              className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 hover:text-rose-400 text-slate-300 text-xs font-semibold rounded-lg border border-slate-700 transition-all active:scale-[0.97]"
            >
              Salir
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 flex flex-col lg:flex-row gap-6">

        {/* Navigation Sidebar / Tabs */}
        <section className="w-full lg:w-64 flex flex-row lg:flex-col gap-2 pb-2 lg:pb-0 shrink-0 lg:h-fit">
          <button
            onClick={() => setActiveTab("matches")}
            className={`flex-1 lg:flex-none lg:w-full px-4 py-3 rounded-xl font-bold text-sm text-center lg:text-left flex items-center justify-center lg:justify-start space-x-2.5 transition-all shrink-0 ${activeTab === "matches"
                ? "bg-gradient-to-r from-amber-500/20 to-indigo-500/5 border-b-2 lg:border-b-0 lg:border-l-4 border-amber-500 text-amber-400"
                : "bg-slate-900/40 hover:bg-slate-900/80 text-slate-400 hover:text-slate-200 border-b-2 border-transparent lg:border-b-0"
              }`}
          >
            <span>📅</span>
            <span>Pronósticos</span>
          </button>

          <button
            onClick={() => setActiveTab("leaderboard")}
            className={`flex-1 lg:flex-none lg:w-full px-4 py-3 rounded-xl font-bold text-sm text-center lg:text-left flex items-center justify-center lg:justify-start space-x-2.5 transition-all shrink-0 ${activeTab === "leaderboard"
                ? "bg-gradient-to-r from-sky-500/20 to-indigo-500/5 border-b-2 lg:border-b-0 lg:border-l-4 border-sky-500 text-sky-400"
                : "bg-slate-900/40 hover:bg-slate-900/80 text-slate-400 hover:text-slate-200 border-b-2 border-transparent lg:border-b-0"
              }`}
          >
            <span>🏆</span>
            <span>Posiciones</span>
          </button>

          {profile?.isAdmin && (
            <button
              onClick={() => setActiveTab("admin")}
              className={`flex-1 lg:flex-none lg:w-full px-4 py-3 rounded-xl font-bold text-sm text-center lg:text-left flex items-center justify-center lg:justify-start space-x-2.5 transition-all shrink-0 ${activeTab === "admin"
                  ? "bg-gradient-to-r from-amber-500/20 to-yellow-500/10 border-b-2 lg:border-b-0 lg:border-l-4 border-amber-500 text-amber-400"
                  : "bg-slate-900/40 hover:bg-slate-900/80 text-slate-400 hover:text-slate-200 border-b-2 border-transparent lg:border-b-0"
                }`}
            >
              <span>⚙️</span>
              <span>Administrar</span>
            </button>
          )}
        </section>

        {/* Content Area */}
        <section className="flex-1">
          {dataLoading ? (
            <div className="h-64 flex flex-col items-center justify-center bg-slate-900/20 rounded-2xl border border-slate-900">
              <div className="w-10 h-10 border-3 border-amber-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="mt-3 text-slate-500 text-sm animate-pulse">Obteniendo datos de Firebase...</p>
            </div>
          ) : (
            <>
              {/* TAB: PRONÓSTICOS */}
              {activeTab === "matches" && (
                <div className="space-y-6">
                  {/* Round Filter */}
                  <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-3.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-extrabold text-slate-200">Calendario Oficial</h2>
                      <p className="text-slate-400 text-[11px]">Completa tus predicciones del Mundial</p>
                    </div>

                    <div className="flex items-center gap-2.5 w-full sm:w-auto justify-start sm:justify-end">
                      {pastMatchesCount > 0 && (
                        <button
                          onClick={() => setHidePastMatches(!hidePastMatches)}
                          className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all border flex items-center gap-1.5 shrink-0 ${!hidePastMatches
                              ? "bg-amber-950/30 text-amber-400 border-amber-900/40 hover:bg-amber-900/20"
                              : "bg-slate-900/60 text-slate-300 border-slate-800 hover:bg-slate-800"
                            }`}
                        >
                          {!hidePastMatches ? "🙈 Ocultar" : `👁️ Pasados (${pastMatchesCount})`}
                        </button>
                      )}

                      <select
                        value={selectedRound}
                        onChange={(e) => setSelectedRound(e.target.value)}
                        className="px-3.5 py-1.5 bg-slate-950 border border-slate-800 text-slate-350 text-xs rounded-xl focus:outline-none focus:border-amber-500 w-full sm:w-auto"
                      >
                        {rounds.map((round) => (
                          <option key={round} value={round}>{formatRoundName(round)}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Matches Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {userGroupedMatches.length === 0 ? (
                      <div className="col-span-full py-12 text-center text-slate-500 bg-slate-900/10 border border-slate-900/40 rounded-2xl p-6">
                        {pastMatchesCount > 0 && hidePastMatches ? (
                          <>
                            <p className="text-slate-400 text-sm mb-3">Todos los partidos de esta ronda ya pasaron.</p>
                            <button
                              onClick={() => setHidePastMatches(false)}
                              className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-extrabold rounded-xl transition-colors shadow-lg shadow-amber-500/20"
                            >
                              Ver partidos pasados
                            </button>
                          </>
                        ) : (
                          "No se encontraron partidos para esta ronda."
                        )}
                      </div>
                    ) : (
                      userGroupedMatches.map((group) => (
                        <React.Fragment key={group.key}>
                          {/* Day Header */}
                          <div className="col-span-full mt-6 first:mt-0 mb-2">
                            <div className="flex items-center space-x-3">
                              <span className="text-[11px] font-extrabold text-amber-400 uppercase tracking-wider bg-slate-900/80 px-3 py-1.5 rounded-xl border border-slate-800/80 shadow-sm">
                                {group.dateLabel}
                              </span>
                              <div className="h-px bg-slate-900 flex-1"></div>
                            </div>
                          </div>

                          {/* Group Matches */}
                          {group.matches.map((match) => {
                            const pred = predictions[match.id];
                            const draft = predictionDrafts[match.id] || { goals1: "", goals2: "" };
                            const isSaving = savingMatches[match.id];
                            const hasResult = match.result !== null;
                            const isFinal = match.result !== null && match.result.isFinal !== false;
                            const isLive = hasMatchStarted(match) && (match.result === null || match.result.isFinal === false);

                            const matchDate = getMatchDate(match);
                            const localTimeStr = matchDate.toLocaleTimeString(undefined, {
                              hour: '2-digit',
                              minute: '2-digit',
                              hour12: false
                            });
                            const tzAbbr = getTzAbbreviation();

                            return (
                              <div
                                key={match.id}
                                className="bg-slate-900/40 hover:bg-slate-900/60 transition-all border border-slate-900/80 hover:border-slate-800 rounded-2xl p-5 flex flex-col justify-between"
                              >
                                {/* Match Header */}
                                <div className="flex justify-between items-center text-xs text-slate-400 border-b border-slate-950/60 pb-3 mb-4 relative">
                                  <span className="font-bold text-amber-500">{formatRoundName(match.round)} {match.group ? `• ${match.group}` : ""}</span>
                                  {isLive && (
                                    <div className="absolute left-1/2 -translate-x-1/2">
                                      <span className="text-[10px] sm:text-xs bg-amber-500/15 border border-amber-500/30 text-amber-500 px-2.5 py-1 rounded-lg font-extrabold flex items-center gap-1.5 animate-pulse">
                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span>
                                        ⚡ En Juego
                                      </span>
                                    </div>
                                  )}
                                  <span className="font-semibold text-slate-300">{localTimeStr} {tzAbbr}</span>
                                </div>

                                {/* Teams and Inputs */}
                                <div className="flex items-center justify-between gap-3 my-4">
                                  {/* Team 1 */}
                                  {getFlagUrl(match.team1) ? (
                                    <button
                                      type="button"
                                      onClick={() => setSelectedTeamHistory(match.team1)}
                                      title={`Ver historial de partidos de ${match.team1}`}
                                      className="flex-1 flex flex-col items-center justify-center space-y-1.5 min-w-0 group cursor-pointer select-none hover:scale-105 active:scale-95 transition-all p-1 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500/20"
                                    >
                                      <img
                                        src={getFlagUrl(match.team1)!}
                                        alt={match.team1}
                                        className="w-8 h-5.5 object-cover rounded-sm shadow-md border border-slate-900 shrink-0 group-hover:shadow-emerald-500/10 transition-shadow"
                                      />
                                      <span className="font-bold text-xs sm:text-sm text-slate-200 text-center w-full break-words group-hover:text-emerald-400 transition-colors">
                                        {match.team1}
                                      </span>
                                    </button>
                                  ) : (
                                    <div className="flex-1 flex flex-col items-center justify-center space-y-1.5 min-w-0">
                                      <span className="font-bold text-xs sm:text-sm text-slate-400 text-center w-full break-words">
                                        {match.team1}
                                      </span>
                                    </div>
                                  )}

                                  {/* Prediction / Score inputs */}
                                  <div className="flex items-center gap-2 shrink-0">
                                    {/* goals1 stepper */}
                                    <div className="flex flex-col sm:flex-row items-center gap-1">
                                      {!hasMatchStarted(match) && (
                                        <button
                                          type="button"
                                          disabled={isSaving}
                                          onClick={() => {
                                            const current = draft.goals1 === "" ? -1 : parseInt(draft.goals1, 10);
                                            const newVal = (isNaN(current) ? -1 : current) + 1;
                                            setPredictionDrafts(prev => ({ ...prev, [match.id]: { ...draft, goals1: String(newVal) } }));
                                          }}
                                          className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 select-none cursor-pointer order-1 sm:order-3"
                                        >+</button>
                                      )}
                                      <input
                                        type="text"
                                        inputMode="numeric"
                                        pattern="[0-9]*"
                                        value={draft.goals1}
                                        disabled={hasResult || isSaving || hasMatchStarted(match)}
                                        onChange={(e) => {
                                          const val = e.target.value.replace(/[^0-9]/g, "");
                                          setPredictionDrafts(prev => ({ ...prev, [match.id]: { ...draft, goals1: val } }));
                                        }}
                                        className="w-10 h-10 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-base font-extrabold rounded-xl focus:outline-none disabled:opacity-60 disabled:bg-slate-900/30 text-amber-400 order-2"
                                        placeholder="-"
                                      />
                                      {!hasMatchStarted(match) && (
                                        <button
                                          type="button"
                                          disabled={isSaving}
                                          onClick={() => {
                                            const current = draft.goals1 === "" ? 0 : parseInt(draft.goals1, 10);
                                            const newVal = Math.max(0, isNaN(current) ? 0 : current - 1);
                                            setPredictionDrafts(prev => ({ ...prev, [match.id]: { ...draft, goals1: String(newVal) } }));
                                          }}
                                          className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 select-none cursor-pointer order-3 sm:order-1"
                                        >-</button>
                                      )}
                                    </div>

                                    <span className="text-slate-600 font-bold">vs</span>

                                    {/* goals2 stepper */}
                                    <div className="flex flex-col sm:flex-row items-center gap-1">
                                      {!hasMatchStarted(match) && (
                                        <button
                                          type="button"
                                          disabled={isSaving}
                                          onClick={() => {
                                            const current = draft.goals2 === "" ? -1 : parseInt(draft.goals2, 10);
                                            const newVal = (isNaN(current) ? -1 : current) + 1;
                                            setPredictionDrafts(prev => ({ ...prev, [match.id]: { ...draft, goals2: String(newVal) } }));
                                          }}
                                          className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 select-none cursor-pointer order-1 sm:order-3"
                                        >+</button>
                                      )}
                                      <input
                                        type="text"
                                        inputMode="numeric"
                                        pattern="[0-9]*"
                                        value={draft.goals2}
                                        disabled={hasResult || isSaving || hasMatchStarted(match)}
                                        onChange={(e) => {
                                          const val = e.target.value.replace(/[^0-9]/g, "");
                                          setPredictionDrafts(prev => ({ ...prev, [match.id]: { ...draft, goals2: val } }));
                                        }}
                                        className="w-10 h-10 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-base font-extrabold rounded-xl focus:outline-none disabled:opacity-60 disabled:bg-slate-900/30 text-amber-400 order-2"
                                        placeholder="-"
                                      />
                                      {!hasMatchStarted(match) && (
                                        <button
                                          type="button"
                                          disabled={isSaving}
                                          onClick={() => {
                                            const current = draft.goals2 === "" ? 0 : parseInt(draft.goals2, 10);
                                            const newVal = Math.max(0, isNaN(current) ? 0 : current - 1);
                                            setPredictionDrafts(prev => ({ ...prev, [match.id]: { ...draft, goals2: String(newVal) } }));
                                          }}
                                          className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 select-none cursor-pointer order-3 sm:order-1"
                                        >-</button>
                                      )}
                                    </div>
                                  </div>

                                  {/* Team 2 */}
                                  {getFlagUrl(match.team2) ? (
                                    <button
                                      type="button"
                                      onClick={() => setSelectedTeamHistory(match.team2)}
                                      title={`Ver historial de partidos de ${match.team2}`}
                                      className="flex-1 flex flex-col items-center justify-center space-y-1.5 min-w-0 group cursor-pointer select-none hover:scale-105 active:scale-95 transition-all p-1 rounded-xl focus:outline-none focus:ring-1 focus:ring-emerald-500/20"
                                    >
                                      <img
                                        src={getFlagUrl(match.team2)!}
                                        alt={match.team2}
                                        className="w-8 h-5.5 object-cover rounded-sm shadow-md border border-slate-900 shrink-0 group-hover:shadow-emerald-500/10 transition-shadow"
                                      />
                                      <span className="font-bold text-xs sm:text-sm text-slate-200 text-center w-full break-words group-hover:text-emerald-400 transition-colors">
                                        {match.team2}
                                      </span>
                                    </button>
                                  ) : (
                                    <div className="flex-1 flex flex-col items-center justify-center space-y-1.5 min-w-0">
                                      <span className="font-bold text-xs sm:text-sm text-slate-400 text-center w-full break-words">
                                        {match.team2}
                                      </span>
                                    </div>
                                  )}
                                </div>

                                {/* Match Footer */}
                                <div className="mt-4 pt-3 border-t border-slate-950/60 flex items-center justify-between gap-2">
                                  <span className="text-[10px] text-slate-500 truncate min-w-0 flex-1 mr-2" title={match.ground}>
                                    {match.ground}
                                  </span>

                                  {(() => {
                                    if (isFinal) {
                                      return (
                                        <div className="flex items-center space-x-2 shrink-0">
                                          <span className="text-xs bg-slate-950 border border-slate-800 text-slate-400 px-2.5 py-1 rounded-lg whitespace-nowrap">
                                            Final: {match.result?.goals1} - {match.result?.goals2}
                                          </span>
                                          {pred ? (
                                            <span className={`text-xs font-bold px-2 py-1 rounded-lg whitespace-nowrap ${getPointsBadgeClass(pred?.points ?? 0, match.date < "2026-06-13")}`}>
                                              +{pred?.points ?? 0} Pts
                                            </span>
                                          ) : (
                                            <span className="text-xs font-bold px-2 py-1 rounded-lg bg-slate-950 border border-slate-850/80 text-rose-500 whitespace-nowrap">
                                              Sin pronóstico
                                            </span>
                                          )}
                                        </div>
                                      );
                                    }

                                    if (isLive) {
                                      const liveGoals1 = match.result ? match.result.goals1 : 0;
                                      const liveGoals2 = match.result ? match.result.goals2 : 0;
                                      let currentPoints = 0;
                                      if (pred) {
                                        currentPoints = (match.date < "2026-06-13")
                                          ? calculatePointsOld(pred.goals1, pred.goals2, liveGoals1, liveGoals2)
                                          : calculatePointsNew(pred.goals1, pred.goals2, liveGoals1, liveGoals2);
                                      }

                                      return (
                                        <div className="flex items-center space-x-2 shrink-0">
                                          <div className="flex items-center bg-slate-955 border border-slate-800 rounded-lg overflow-hidden whitespace-nowrap">
                                            <span className="text-xs text-slate-350 px-2.5 py-1 font-bold">
                                              En Vivo: <span className="text-amber-400">{liveGoals1} - {liveGoals2}</span>
                                            </span>
                                            <button
                                              onClick={() => refreshLiveMatchScore(match.id)}
                                              disabled={refreshingMatches[match.id]}
                                              title="Actualizar marcador en vivo"
                                              className="border-l border-slate-800 bg-slate-950 hover:bg-slate-900/80 text-amber-400 hover:text-amber-300 p-1.5 transition-all active:scale-[0.9] disabled:opacity-50 flex items-center justify-center"
                                            >
                                              <svg
                                                className={`w-3.5 h-3.5 ${refreshingMatches[match.id] ? "animate-spin text-amber-500" : ""}`}
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="2.5"
                                                viewBox="0 0 24 24"
                                              >
                                                <path
                                                  strokeLinecap="round"
                                                  strokeLinejoin="round"
                                                  d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                                                />
                                              </svg>
                                            </button>
                                          </div>
                                          {pred ? (
                                            <span className={`text-xs font-bold px-2 py-1 rounded-lg whitespace-nowrap ${getPointsBadgeClass(currentPoints, match.date < "2026-06-13")}`}>
                                              +{currentPoints} Pts (Prov.)
                                            </span>
                                          ) : (
                                            <span className="text-xs font-bold px-2 py-1 rounded-lg bg-slate-950 border border-slate-850/80 text-rose-500 whitespace-nowrap">
                                              Sin pronóstico
                                            </span>
                                          )}
                                        </div>
                                      );
                                    }

                                    // Not started yet
                                    return (
                                      <button
                                        onClick={() => savePrediction(match.id)}
                                        disabled={isSaving || draft.goals1 === "" || draft.goals2 === ""}
                                        className="px-4 py-1.5 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-850 disabled:text-slate-600 disabled:border-slate-800/80 text-slate-950 font-bold text-xs rounded-xl transition-all shadow-md active:scale-[0.95]"
                                      >
                                        {isSaving ? "Guardando..." : pred ? "Actualizar" : "Guardar"}
                                      </button>
                                    );
                                  })()}
                                </div>
                              </div>
                            );
                          })}
                        </React.Fragment>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* TAB: LEADERBOARD */}
              {activeTab === "leaderboard" && (
                <div className="space-y-6">
                  <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-6">
                    <h2 className="text-xl font-extrabold text-slate-200">Tabla de Clasificación</h2>
                    <p className="text-slate-400 text-xs mt-1">
                      Conoce a los mejores pronosticadores de la copa • <span className="text-amber-400 font-semibold">Toca sobre cualquier jugador para auditar sus pronósticos 👁️</span>
                    </p>

                    {/* Selectora de Fase */}
                    <div className="flex bg-slate-950/60 p-1 rounded-xl border border-slate-900 max-w-md mt-5">
                      <button
                        onClick={() => setLeaderboardPhase("new")}
                        className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${leaderboardPhase === "new"
                            ? "bg-gradient-to-r from-amber-500 to-yellow-500 text-slate-950 shadow-md"
                            : "text-slate-400 hover:text-slate-200"
                          }`}
                      >
                        Fase Nueva (Desde Jun 13)
                      </button>
                      <button
                        onClick={() => setLeaderboardPhase("old")}
                        className={`flex-1 py-2 text-xs font-bold rounded-lg transition-all ${leaderboardPhase === "old"
                            ? "bg-gradient-to-r from-amber-500 to-yellow-500 text-slate-950 shadow-md"
                            : "text-slate-400 hover:text-slate-200"
                          }`}
                      >
                        Fase Anterior (Hasta Jun 12)
                      </button>
                    </div>



                    <div className="mt-6 overflow-x-auto rounded-xl border border-slate-950 bg-slate-950/20">
                      <table className="w-full text-left border-collapse min-w-[500px]">
                        <thead>
                          <tr className="bg-slate-900/60 text-slate-400 text-[10px] sm:text-xs font-semibold uppercase tracking-wider">
                            <th className="py-3 sm:py-4 px-3 sm:px-6 text-center w-16">Pos</th>
                            <th className="py-3 sm:py-4 px-3 sm:px-6">Jugador</th>
                            <th className="py-3 sm:py-4 px-3 sm:px-6 text-center">Apostados</th>
                            <th className="py-3 sm:py-4 px-3 sm:px-6 text-right">Inversión</th>
                            <th className="py-3 sm:py-4 px-3 sm:px-6 text-right">Premios</th>
                            <th className="py-3 sm:py-4 px-3 sm:px-6 text-right w-24">Puntos</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-950">
                          {sortedLeaderboard.map((userProf, index) => {
                            const isMe = userProf.uid === user.uid;
                            const userStats = leaderboardPhase === "new"
                              ? (financialStats.statsNew[userProf.uid] || { invested: 0, winnings: 0, balance: 0, predictionsCount: 0 })
                              : (financialStats.statsOld[userProf.uid] || { invested: 0, winnings: 0, balance: 0, predictionsCount: 0 });
                            const userCalc = calculatedPoints[userProf.uid] || { pointsOld: 0, pointsNew: 0 };
                            const pts = leaderboardPhase === "new"
                              ? userCalc.pointsNew
                              : userCalc.pointsOld;
                            return (
                              <tr
                                key={userProf.uid}
                                className={`text-xs sm:text-sm hover:bg-slate-900/40 transition-colors cursor-pointer group ${isMe ? "bg-amber-500/5 text-amber-400 font-bold" : "text-slate-355"
                                  }`}
                                onClick={() => setViewingUser(userProf)}
                                title={`Ver pronósticos de ${userProf.displayName}`}
                              >
                                <td className="py-3 sm:py-4 px-3 sm:px-6 text-center font-extrabold">
                                  {index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : index + 1}
                                </td>
                                <td className="py-3 sm:py-4 px-3 sm:px-6 truncate max-w-[120px] sm:max-w-[200px]">
                                  <span className="align-middle hover:text-amber-400 transition-colors">{userProf.displayName}</span>
                                  <span className="inline-block ml-1.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity text-slate-500 text-[10px] align-middle">👁️</span>
                                  {isMe && <span className="text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded ml-2 align-middle">Tú</span>}
                                </td>
                                <td className="py-3 sm:py-4 px-3 sm:px-6 text-center text-slate-400">
                                  {userStats.predictionsCount}
                                </td>
                                <td className="py-3 sm:py-4 px-3 sm:px-6 text-right text-slate-400">
                                  ${userStats.invested}
                                </td>
                                <td className="py-3 sm:py-4 px-3 sm:px-6 text-right text-amber-400">
                                  ${userStats.winnings.toFixed(0)}
                                </td>
                                <td className="py-3 sm:py-4 px-3 sm:px-6 text-right font-extrabold text-amber-400">
                                  {pts}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Scoring System Information */}
                    <div className="mt-8 pt-6 border-t border-slate-900">
                      <h3 className="text-base font-bold text-slate-200 flex items-center space-x-2">
                        <span>🎯</span>
                        <span>Sistema de Puntuación (Partidos de hoy en adelante)</span>
                      </h3>
                      <p className="text-xs text-slate-400 mt-1">Cómo se calculan los puntos de cada partido a partir de hoy (13 de junio):</p>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
                        <div className="flex items-start space-x-3 p-5 rounded-xl bg-slate-950/20 hover:bg-slate-950/40 transition-colors border border-slate-900">
                          <span className="text-sm font-bold px-2.5 py-0.5 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20 shrink-0">+5 Pts</span>
                          <div>
                            <h4 className="text-sm font-bold text-slate-300">Marcador Exacto</h4>
                            <p className="text-xs text-slate-500 mt-0.5">Le atinas al resultado idéntico del partido.</p>
                            <span className="text-[11px] text-amber-500/80 block mt-1">E.g., Pred: 2-1 | Real: 2-1</span>
                          </div>
                        </div>

                        <div className="flex items-start space-x-3 p-5 rounded-xl bg-slate-950/20 hover:bg-slate-950/40 transition-colors border border-slate-900">
                          <span className="text-sm font-bold px-2.5 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">+3 Pts</span>
                          <div>
                            <h4 className="text-sm font-bold text-slate-300">Ganador y Diferencia</h4>
                            <p className="text-xs text-slate-500 mt-0.5">Aciertas qué equipo gana y por cuántos goles de diferencia (solo para ganadores, no empates).</p>
                            <span className="text-[11px] text-emerald-500/80 block mt-1">E.g., Pred: 3-1 | Real: 2-0 (Ambos dif +2)</span>
                          </div>
                        </div>

                        <div className="flex items-start space-x-3 p-5 rounded-xl bg-slate-950/20 hover:bg-slate-950/40 transition-colors border border-slate-900">
                          <span className="text-sm font-bold px-2.5 py-0.5 rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">+1 Pt</span>
                          <div>
                            <h4 className="text-sm font-bold text-slate-300">Resultado Simple</h4>
                            <p className="text-xs text-slate-500 mt-0.5">Aciertas quién gana con otra diferencia, o aciertas empate no exacto.</p>
                            <span className="text-[11px] text-blue-500/80 block mt-1">E.g., Pred: 2-1 | Real: 1-0 o Pred: 1-1 | Real: 2-2</span>
                          </div>
                        </div>
                      </div>

                      <p className="text-[11px] text-slate-500 mt-4 italic">
                        * Nota: Los partidos anteriores a hoy mantienen la liquidación acumulada original (+1 por acierto exacto). Los puntos de ambas fases se muestran por separado en la tabla superior.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB: ADMIN PANEL */}
              {activeTab === "admin" && profile?.isAdmin && (
                <div className="space-y-6">
                  {/* Admin Header & Sub-Tabs */}
                  <div className="bg-gradient-to-r from-amber-500/10 to-yellow-500/5 border border-amber-500/20 rounded-2xl p-5">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                      <div>
                        <h2 className="text-xl font-extrabold text-amber-400">Panel de Administración</h2>
                        <p className="text-slate-400 text-xs mt-1">
                          Controla los resultados reales del mundial o ajusta las predicciones de los participantes de forma manual.
                        </p>
                      </div>
                      <button
                        onClick={recalculateAllScores}
                        disabled={adminRecalculating}
                        className="px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:bg-slate-800 text-slate-950 font-bold text-xs rounded-xl shadow-md transition-all self-start md:self-center"
                      >
                        {adminRecalculating ? "Recalculando..." : "🔄 Recalcular Todos los Puntos"}
                      </button>
                    </div>

                    {/* Sub-Tabs Navigation */}
                    <div className="flex space-x-2 mt-4 border-t border-slate-900 pt-4">
                      <button
                        onClick={() => setAdminSubTab("results")}
                        className={`px-4 py-2 rounded-xl text-xs font-extrabold transition-all border ${adminSubTab === "results"
                            ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                            : "bg-slate-950/40 border-slate-900 text-slate-400 hover:text-slate-200"
                          }`}
                      >
                        ⚽ Resultados del Mundial
                      </button>
                      <button
                        onClick={() => setAdminSubTab("predictions")}
                        className={`px-4 py-2 rounded-xl text-xs font-extrabold transition-all border ${adminSubTab === "predictions"
                            ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                            : "bg-slate-950/40 border-slate-900 text-slate-400 hover:text-slate-200"
                          }`}
                      >
                        👤 Pronósticos de Jugadores
                      </button>
                      <button
                        onClick={() => setAdminSubTab("users")}
                        className={`px-4 py-2 rounded-xl text-xs font-extrabold transition-all border ${adminSubTab === "users"
                            ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                            : "bg-slate-950/40 border-slate-900 text-slate-400 hover:text-slate-200"
                          }`}
                      >
                        👥 Gestionar Usuarios
                      </button>
                    </div>
                  </div>

                  {/* Sub-Tab 1: Results */}
                  {adminSubTab === "results" && (
                    <div className="space-y-4">
                      {/* Round Selector in Admin for convenience */}
                      <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <div>
                          <h3 className="font-bold text-slate-200 text-sm">Filtrar por Ronda</h3>
                          <p className="text-slate-400 text-[10px]">Filtra los partidos para registrar marcadores con mayor comodidad</p>
                        </div>
                        <div className="flex items-center gap-2.5 w-full md:w-auto justify-start md:justify-end">
                          {pastMatchesCount > 0 && (
                            <button
                              onClick={() => setHidePastMatchesAdmin(!hidePastMatchesAdmin)}
                              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all border flex items-center gap-1.5 shrink-0 ${!hidePastMatchesAdmin
                                  ? "bg-amber-950/30 text-amber-400 border-amber-900/40 hover:bg-amber-900/20"
                                  : "bg-slate-900/60 text-slate-300 border-slate-800 hover:bg-slate-800"
                                }`}
                            >
                              {!hidePastMatchesAdmin ? "🙈 Ocultar" : `👁️ Pasados (${pastMatchesCount})`}
                            </button>
                          )}
                          <select
                            value={selectedRound}
                            onChange={(e) => setSelectedRound(e.target.value)}
                            className="px-4 py-2 bg-slate-950 border border-slate-800 text-slate-300 text-sm rounded-xl focus:outline-none focus:border-amber-500 w-full md:w-auto"
                          >
                            {rounds.map((round) => (
                              <option key={round} value={round}>{formatRoundName(round)}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      <div className="space-y-6">
                        {groupedMatches.length === 0 ? (
                          <div className="col-span-full py-12 text-center text-slate-500 bg-slate-900/10 border border-slate-900/40 rounded-2xl p-6">
                            {pastMatchesCount > 0 && hidePastMatchesAdmin ? (
                              <>
                                <p className="text-slate-400 text-sm mb-3">Todos los partidos de esta ronda ya pasaron o están archivados.</p>
                                <button
                                  onClick={() => setHidePastMatchesAdmin(false)}
                                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-extrabold rounded-xl transition-colors shadow-lg shadow-amber-500/20"
                                >
                                  Ver partidos pasados
                                </button>
                              </>
                            ) : (
                              "No se encontraron partidos para esta ronda."
                            )}
                          </div>
                        ) : (
                          groupedMatches.map((group) => (
                            <React.Fragment key={group.key}>
                              {/* Day Header */}
                              <div className="mt-6 first:mt-0 mb-2">
                                <div className="flex items-center space-x-3">
                                  <span className="text-[10px] font-extrabold text-amber-500 uppercase tracking-wider bg-slate-900/80 px-2.5 py-1.5 rounded-lg border border-slate-800/80 shadow-sm">
                                    {group.dateLabel}
                                  </span>
                                  <div className="h-px bg-slate-900 flex-1"></div>
                                </div>
                              </div>

                              <div className="space-y-4">
                                {group.matches.map((match) => {
                                  const draft = adminResults[match.id] || { goals1: "", goals2: "" };
                                  const isSaving = adminSaving[match.id];

                                  const matchDate = getMatchDate(match);
                                  const localTimeStr = matchDate.toLocaleTimeString(undefined, {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    hour12: false
                                  });
                                  const tzAbbr = getTzAbbreviation();

                                  return (
                                    <div
                                      key={match.id}
                                      className="bg-slate-900/40 border border-slate-900/80 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
                                    >
                                      <div className="flex-1">
                                        <span className="text-xs text-amber-500 font-semibold">{formatRoundName(match.round)} • Partido {match.num}</span>
                                        <h3 className="font-bold text-slate-200 mt-0.5 flex items-center space-x-2">
                                          {getFlagUrl(match.team1) && (
                                            <img
                                              src={getFlagUrl(match.team1)!}
                                              alt={match.team1}
                                              className="w-5 h-3.5 object-cover rounded-sm shadow-sm border border-slate-900"
                                            />
                                          )}
                                          <span>{match.team1}</span>
                                          <span className="text-slate-500 font-semibold text-xs">vs</span>
                                          <span>{match.team2}</span>
                                          {getFlagUrl(match.team2) && (
                                            <img
                                              src={getFlagUrl(match.team2)!}
                                              alt={match.team2}
                                              className="w-5 h-3.5 object-cover rounded-sm shadow-sm border border-slate-900"
                                            />
                                          )}
                                        </h3>
                                        <span className="text-[10px] text-slate-500">{match.ground} • {localTimeStr} {tzAbbr}</span>
                                      </div>

                                      <div className="flex items-center gap-3">
                                        {/* goals1 stepper */}
                                        <div className="flex flex-col sm:flex-row items-center gap-1">
                                          <button
                                            type="button"
                                            disabled={isSaving}
                                            onClick={() => {
                                              const current = draft.goals1 === "" ? -1 : parseInt(draft.goals1, 10);
                                              const newVal = (isNaN(current) ? -1 : current) + 1;
                                              setAdminResults(prev => ({ ...prev, [match.id]: { ...draft, goals1: String(newVal) } }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 select-none cursor-pointer order-1 sm:order-3"
                                          >+</button>
                                          <input
                                            type="text"
                                            inputMode="numeric"
                                            pattern="[0-9]*"
                                            value={draft.goals1}
                                            onChange={(e) => {
                                              const val = e.target.value.replace(/[^0-9]/g, "");
                                              setAdminResults(prev => ({ ...prev, [match.id]: { ...draft, goals1: val } }));
                                            }}
                                            className="w-10 h-10 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-base font-bold rounded-lg focus:outline-none text-amber-400 order-2"
                                            placeholder={match.result ? String(match.result.goals1) : "-"}
                                          />
                                          <button
                                            type="button"
                                            disabled={isSaving}
                                            onClick={() => {
                                              const current = draft.goals1 === "" ? 0 : parseInt(draft.goals1, 10);
                                              const newVal = Math.max(0, isNaN(current) ? 0 : current - 1);
                                              setAdminResults(prev => ({ ...prev, [match.id]: { ...draft, goals1: String(newVal) } }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 select-none cursor-pointer order-3 sm:order-1"
                                          >-</button>
                                        </div>

                                        <span className="text-slate-600 font-bold">vs</span>

                                        {/* goals2 stepper */}
                                        <div className="flex flex-col sm:flex-row items-center gap-1">
                                          <button
                                            type="button"
                                            disabled={isSaving}
                                            onClick={() => {
                                              const current = draft.goals2 === "" ? -1 : parseInt(draft.goals2, 10);
                                              const newVal = (isNaN(current) ? -1 : current) + 1;
                                              setAdminResults(prev => ({ ...prev, [match.id]: { ...draft, goals2: String(newVal) } }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 select-none cursor-pointer order-1 sm:order-3"
                                          >+</button>
                                          <input
                                            type="text"
                                            inputMode="numeric"
                                            pattern="[0-9]*"
                                            value={draft.goals2}
                                            onChange={(e) => {
                                              const val = e.target.value.replace(/[^0-9]/g, "");
                                              setAdminResults(prev => ({ ...prev, [match.id]: { ...draft, goals2: val } }));
                                            }}
                                            className="w-10 h-10 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-base font-bold rounded-lg focus:outline-none text-amber-400 order-2"
                                            placeholder={match.result ? String(match.result.goals2) : "-"}
                                          />
                                          <button
                                            type="button"
                                            disabled={isSaving}
                                            onClick={() => {
                                              const current = draft.goals2 === "" ? 0 : parseInt(draft.goals2, 10);
                                              const newVal = Math.max(0, isNaN(current) ? 0 : current - 1);
                                              setAdminResults(prev => ({ ...prev, [match.id]: { ...draft, goals2: String(newVal) } }));
                                            }}
                                            className="w-7 h-7 flex items-center justify-center bg-slate-900 border border-slate-800 hover:border-amber-500/40 hover:text-amber-400 text-slate-400 font-extrabold text-sm rounded-lg transition-all active:scale-90 disabled:opacity-30 select-none cursor-pointer order-3 sm:order-1"
                                          >-</button>
                                        </div>

                                        <label className="flex items-center space-x-1.5 cursor-pointer select-none text-xs text-slate-300">
                                          <input
                                            type="checkbox"
                                            checked={draft.isFinal ?? true}
                                            onChange={(e) => {
                                              setAdminResults(prev => ({
                                                ...prev,
                                                [match.id]: { ...draft, isFinal: e.target.checked }
                                              }));
                                            }}
                                            className="rounded border-slate-800 text-amber-500 focus:ring-amber-500 bg-slate-950 w-4 h-4"
                                          />
                                          <span>Final</span>
                                        </label>

                                        <button
                                          onClick={() => saveMatchResult(match.id)}
                                          disabled={isSaving || draft.goals1 === "" || draft.goals2 === ""}
                                          className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-lg shadow-md disabled:opacity-50 transition-all"
                                        >
                                          {isSaving ? "Guardando..." : "Registrar"}
                                        </button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </React.Fragment>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {/* Sub-Tab 2: User Predictions Editing */}
                  {adminSubTab === "predictions" && (
                    <div className="space-y-4">
                      {/* Player and Round Selectors */}
                      <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-5 flex flex-col md:flex-row gap-4 items-start md:items-center justify-between">
                        <div className="w-full md:w-auto">
                          <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                            Seleccionar Jugador
                          </label>
                          <select
                            value={adminSelectedUserId}
                            onChange={(e) => setAdminSelectedUserId(e.target.value)}
                            className="w-full md:w-64 px-4 py-2.5 bg-slate-950 border border-slate-800 text-slate-300 text-sm rounded-xl focus:outline-none focus:border-amber-500"
                          >
                            <option value="">-- Selecciona un jugador --</option>
                            {leaderboard.map((userProf) => (
                              <option key={userProf.uid} value={userProf.uid}>
                                {userProf.displayName} ({userProf.email})
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="w-full md:w-auto">
                          <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1.5">
                            Filtrar por Ronda
                          </label>
                          <div className="flex items-center gap-2.5 w-full md:w-auto justify-start md:justify-end">
                            {pastMatchesCount > 0 && (
                              <button
                                onClick={() => setHidePastMatchesAdmin(!hidePastMatchesAdmin)}
                                className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all border flex items-center gap-1.5 shrink-0 ${!hidePastMatchesAdmin
                                    ? "bg-amber-950/30 text-amber-400 border-amber-900/40 hover:bg-amber-900/20"
                                    : "bg-slate-900/60 text-slate-300 border-slate-800 hover:bg-slate-800"
                                  }`}
                              >
                                {!hidePastMatchesAdmin ? "🙈 Ocultar" : `👁️ Pasados (${pastMatchesCount})`}
                              </button>
                            )}
                            <select
                              value={selectedRound}
                              onChange={(e) => setSelectedRound(e.target.value)}
                              className="w-full md:w-64 px-4 py-2 bg-slate-950 border border-slate-800 text-slate-300 text-sm rounded-xl focus:outline-none focus:border-amber-500"
                            >
                              {rounds.map((round) => (
                                <option key={round} value={round}>{formatRoundName(round)}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      </div>

                      {/* User Matches Grid */}
                      {!adminSelectedUserId ? (
                        <div className="text-center py-16 bg-slate-900/20 border border-slate-900/50 rounded-2xl text-slate-500">
                          <span className="text-4xl block mb-2">👤</span>
                          Por favor, selecciona un jugador de la lista superior para visualizar y editar sus pronósticos.
                        </div>
                      ) : (
                        <div className="space-y-6">
                          {groupedMatches.length === 0 ? (
                            <div className="col-span-full py-12 text-center text-slate-500 bg-slate-900/10 border border-slate-900/40 rounded-2xl p-6">
                              {pastMatchesCount > 0 && hidePastMatchesAdmin ? (
                                <>
                                  <p className="text-slate-400 text-sm mb-3">Todos los partidos de esta ronda ya pasaron o están archivados.</p>
                                  <button
                                    onClick={() => setHidePastMatchesAdmin(false)}
                                    className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-slate-950 text-xs font-extrabold rounded-xl transition-colors shadow-lg shadow-amber-500/20"
                                  >
                                    Ver partidos pasados
                                  </button>
                                </>
                              ) : (
                                "No se encontraron partidos para esta ronda."
                              )}
                            </div>
                          ) : (
                            groupedMatches.map((group) => (
                              <React.Fragment key={group.key}>
                                {/* Day Header */}
                                <div className="mt-6 first:mt-0 mb-2">
                                  <div className="flex items-center space-x-3">
                                    <span className="text-[10px] font-extrabold text-amber-500 uppercase tracking-wider bg-slate-900/80 px-2.5 py-1.5 rounded-lg border border-slate-800/80 shadow-sm">
                                      {group.dateLabel}
                                    </span>
                                    <div className="h-px bg-slate-900 flex-1"></div>
                                  </div>
                                </div>

                                <div className="space-y-4">
                                  {group.matches.map((match) => {
                                    const pred = adminUserPredictions[match.id];
                                    const draft = adminUserDrafts[match.id] || { goals1: "", goals2: "" };
                                    const isSaving = adminSavingUserPreds[match.id];
                                    const hasResult = match.result !== null;

                                    const matchDate = getMatchDate(match);
                                    const localTimeStr = matchDate.toLocaleTimeString(undefined, {
                                      hour: '2-digit',
                                      minute: '2-digit',
                                      hour12: false
                                    });
                                    const tzAbbr = getTzAbbreviation();

                                    return (
                                      <div
                                        key={match.id}
                                        className="bg-slate-900/40 border border-slate-900/80 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
                                      >
                                        {/* Match Team Info */}
                                        <div className="flex-1">
                                          <span className="text-xs text-amber-500 font-semibold">{formatRoundName(match.round)} • Partido {match.num}</span>
                                          <h3 className="font-bold text-slate-200 mt-0.5 flex items-center space-x-2">
                                            {getFlagUrl(match.team1) && (
                                              <img
                                                src={getFlagUrl(match.team1)!}
                                                alt={match.team1}
                                                className="w-5 h-3.5 object-cover rounded-sm shadow-sm border border-slate-900"
                                              />
                                            )}
                                            <span>{match.team1}</span>
                                            <span className="text-slate-500 font-semibold text-xs">vs</span>
                                            <span>{match.team2}</span>
                                            {getFlagUrl(match.team2) && (
                                              <img
                                                src={getFlagUrl(match.team2)!}
                                                alt={match.team2}
                                                className="w-5 h-3.5 object-cover rounded-sm shadow-sm border border-slate-900"
                                              />
                                            )}
                                          </h3>
                                          <div className="flex items-center space-x-2 mt-1">
                                            <span className="text-[10px] text-slate-500">{localTimeStr} {tzAbbr} • {match.ground}</span>
                                            {hasResult && (
                                              <span className="text-[10px] bg-slate-950 border border-slate-800 text-slate-400 px-1.5 py-0.5 rounded">
                                                Resultado real: {match.result?.goals1} - {match.result?.goals2}
                                              </span>
                                            )}
                                          </div>
                                        </div>

                                        {/* Inputs and Save Buttons */}
                                        <div className="flex items-center space-x-3 self-end md:self-center">
                                          <div className="flex items-center space-x-1.5">
                                            <input
                                              type="text"
                                              inputMode="numeric"
                                              pattern="[0-9]*"
                                              value={draft.goals1}
                                              onChange={(e) => {
                                                const val = e.target.value.replace(/[^0-9]/g, "");
                                                setAdminUserDrafts(prev => ({
                                                  ...prev,
                                                  [match.id]: { ...draft, goals1: val }
                                                }));
                                              }}
                                              className="w-12 h-10 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-md font-bold rounded-lg focus:outline-none text-slate-200"
                                              placeholder={pred ? String(pred.goals1) : "-"}
                                            />
                                            <span className="text-slate-650 font-bold text-xs">vs</span>
                                            <input
                                              type="text"
                                              inputMode="numeric"
                                              pattern="[0-9]*"
                                              value={draft.goals2}
                                              onChange={(e) => {
                                                const val = e.target.value.replace(/[^0-9]/g, "");
                                                setAdminUserDrafts(prev => ({
                                                  ...prev,
                                                  [match.id]: { ...draft, goals2: val }
                                                }));
                                              }}
                                              className="w-12 h-10 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-md font-bold rounded-lg focus:outline-none text-slate-200"
                                              placeholder={pred ? String(pred.goals2) : "-"}
                                            />
                                          </div>

                                          {/* Points Indicator if match has result */}
                                          {hasResult && pred && (
                                            <span className={`text-xs font-bold px-2 py-1.5 rounded-lg ${getPointsBadgeClass(pred.points, match.date < "2026-06-13")}`}>
                                              +{pred.points} Pts
                                            </span>
                                          )}

                                          <button
                                            onClick={() => saveUserPredictionByAdmin(match.id)}
                                            disabled={isSaving || draft.goals1 === "" || draft.goals2 === ""}
                                            className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs rounded-lg shadow-md disabled:opacity-50 transition-all"
                                          >
                                            {isSaving ? "Guardando..." : pred ? "Modificar" : "Asignar"}
                                          </button>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </React.Fragment>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Sub-Tab 3: User Management */}
                  {adminSubTab === "users" && (
                    <div className="space-y-6">
                      <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <div>
                          <h3 className="font-bold text-slate-200 text-sm">Gestionar Usuarios</h3>
                          <p className="text-slate-400 text-[10px]">Edita la información de los jugadores o elimínalos del torneo</p>
                        </div>
                        <div className="text-xs text-slate-400 font-bold bg-slate-950 px-3 py-1.5 rounded-xl border border-slate-800">
                          Total Jugadores: <span className="text-amber-400">{leaderboard.length}</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        {leaderboard.map((uProf) => {
                          const isSelf = uProf.uid === user?.uid;
                          const totalPoints = uProf.points + (uProf.previousPoints || 0);
                          const isDeleting = adminDeletingUser[uProf.uid];

                          return (
                            <div 
                              key={uProf.uid}
                              className="bg-slate-900/30 hover:bg-slate-900/50 transition-all border border-slate-900/80 hover:border-slate-850 rounded-2xl p-5 flex flex-col justify-between space-y-4"
                            >
                              {/* Header Profile Info */}
                              <div className="flex items-start justify-between">
                                <div className="flex items-center space-x-3 min-w-0">
                                  {/* Avatar circle */}
                                  <div className="w-10 h-10 rounded-full bg-slate-950 border border-slate-800 flex items-center justify-center font-black text-amber-400 uppercase text-sm shrink-0">
                                    {uProf.displayName ? uProf.displayName.slice(0, 2) : "U"}
                                  </div>
                                  <div className="min-w-0">
                                    <h4 className="font-bold text-slate-200 text-sm flex items-center gap-1.5 truncate">
                                      <span>{uProf.displayName}</span>
                                      {uProf.isAdmin && (
                                        <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded-md text-[9px] font-black tracking-wide shrink-0">
                                          ADMIN
                                        </span>
                                      )}
                                    </h4>
                                    <p className="text-[11px] text-slate-400 truncate">{uProf.email}</p>
                                  </div>
                                </div>
                              </div>

                              {/* Points Breakdown */}
                              <div className="bg-slate-950/40 border border-slate-900/60 rounded-xl p-3 grid grid-cols-3 gap-2 text-center text-xs">
                                <div>
                                  <p className="text-[9px] text-slate-500 font-bold uppercase tracking-wider mb-0.5">Nueva</p>
                                  <p className="font-extrabold text-amber-500">{uProf.points} Pts</p>
                                </div>
                                <div className="border-x border-slate-900">
                                  <p className="text-[9px] text-slate-500 font-bold uppercase tracking-wider mb-0.5">Ant.</p>
                                  <p className="font-extrabold text-slate-400">{uProf.previousPoints || 0} Pts</p>
                                </div>
                                <div>
                                  <p className="text-[9px] text-slate-500 font-bold uppercase tracking-wider mb-0.5">Total</p>
                                  <p className="font-black text-slate-200">{totalPoints} Pts</p>
                                </div>
                              </div>

                              {/* Action Buttons */}
                              <div className="flex gap-2 pt-2">
                                <button
                                  onClick={() => {
                                    setEditingUser(uProf);
                                    setEditUserDraft({
                                      displayName: uProf.displayName,
                                      email: uProf.email,
                                      points: String(uProf.points),
                                      previousPoints: String(uProf.previousPoints || 0),
                                      isAdmin: !!uProf.isAdmin
                                    });
                                  }}
                                  className="flex-1 px-3 py-2 bg-slate-950 border border-slate-800 hover:bg-slate-900/80 text-slate-300 font-bold text-xs rounded-xl transition-all flex items-center justify-center gap-1.5"
                                >
                                  ✏️ Editar
                                </button>
                                <button
                                  onClick={() => deleteUserByAdmin(uProf.uid, uProf.displayName)}
                                  disabled={isSelf || isDeleting}
                                  className="flex-1 px-3 py-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/15 disabled:opacity-40 disabled:hover:bg-rose-500/10 disabled:hover:text-rose-400 font-bold text-xs rounded-xl transition-all flex items-center justify-center gap-1.5"
                                >
                                  {isDeleting ? "Eliminando..." : "🗑️ Eliminar"}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </main>

      {/* Modal de Historial de Pronósticos de otro Usuario */}
      {viewingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 max-w-2xl w-full shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] flex flex-col">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-4 shrink-0">
              <div className="space-y-1">
                <h2 className="text-lg sm:text-xl font-black text-slate-100 flex items-center gap-2">
                  <span>🏆</span>
                  <span>Pronósticos de {viewingUser.displayName}</span>
                </h2>
                {(() => {
                  const userCalc = calculatedPoints[viewingUser.uid] || { pointsOld: 0, pointsNew: 0 };
                  return (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                      <span>
                        Fase Nueva: <span className="text-amber-400 font-extrabold">{userCalc.pointsNew} Pts</span>
                      </span>
                      <span className="text-slate-700">•</span>
                      <span>
                        Fase Anterior: <span className="text-slate-300 font-extrabold">{userCalc.pointsOld} Pts</span>
                      </span>
                      <span className="text-slate-700">•</span>
                      <span>
                        Total: <span className="text-slate-200 font-extrabold">{userCalc.pointsNew + userCalc.pointsOld} Pts</span>
                      </span>
                    </div>
                  );
                })()}
              </div>
              <button 
                onClick={() => {
                  setViewingUser(null);
                  setViewingUserFilter("started");
                }}
                className="text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 w-8 h-8 rounded-full flex items-center justify-center transition-colors font-bold"
              >
                ✕
              </button>
            </div>

            {/* Filter Tabs */}
            <div className="flex gap-2 shrink-0 bg-slate-950/50 p-1 rounded-xl border border-slate-800/60 w-fit">
              <button
                onClick={() => setViewingUserFilter("started")}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  viewingUserFilter === "started"
                    ? "bg-amber-500 text-slate-955 shadow-md"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                ⚡ Partidos Iniciados / Finalizados
              </button>
              <button
                onClick={() => setViewingUserFilter("all")}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  viewingUserFilter === "all"
                    ? "bg-amber-500 text-slate-955 shadow-md"
                    : "text-slate-400 hover:text-slate-200"
                }`}
              >
                📅 Todos los Partidos
              </button>
            </div>

            {/* Match List */}
            <div className="flex-1 overflow-y-auto space-y-3 pr-1 scrollbar-thin scrollbar-thumb-slate-800">
              {(() => {
                const sortedMatches = [...matches].sort((a, b) => {
                  const dateA = getMatchDate(a).getTime();
                  const dateB = getMatchDate(b).getTime();
                  if (dateA !== dateB) {
                    return dateA - dateB;
                  }
                  return a.num - b.num;
                });

                let filteredList = sortedMatches.filter(match => {
                  if (viewingUserFilter === "started") {
                    return hasMatchStarted(match);
                  }
                  return true;
                });

                if (viewingUserFilter === "started") {
                  filteredList = [...filteredList].sort((a, b) => {
                    const dateA = getMatchDate(a).getTime();
                    const dateB = getMatchDate(b).getTime();
                    if (dateA !== dateB) {
                      return dateB - dateA;
                    }
                    return b.num - a.num;
                  });
                }

                if (filteredList.length === 0) {
                  return (
                    <div className="text-center py-12 text-slate-500 text-sm">
                      No hay partidos en esta categoría aún.
                    </div>
                  );
                }

                const renderMatchRow = (match: Match) => {
                  const pred = allPredictions.find(p => p.userId === viewingUser.uid && p.matchId === match.id);
                  const hasStarted = hasMatchStarted(match);
                  const hasResult = match.result !== null;
                  const isLive = hasStarted && (match.result === null || match.result.isFinal === false);

                  const matchDate = getMatchDate(match);
                  const localTimeStr = matchDate.toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false
                  });
                  const tzAbbr = getTzAbbreviation();

                  let pts = 0;
                  const isOld = match.date < "2026-06-13";
                  if (pred) {
                    if (match.result) {
                      pts = isOld
                        ? calculatePointsOld(pred.goals1, pred.goals2, match.result.goals1, match.result.goals2)
                        : calculatePointsNew(pred.goals1, pred.goals2, match.result.goals1, match.result.goals2);
                    } else if (hasStarted) {
                      pts = isOld
                        ? calculatePointsOld(pred.goals1, pred.goals2, 0, 0)
                        : calculatePointsNew(pred.goals1, pred.goals2, 0, 0);
                    }
                  }

                  return (
                    <div key={match.id} className="bg-slate-955/30 border border-slate-850 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-950/60 transition-colors">
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-center sm:justify-start sm:gap-2">
                          <span className="text-[10px] text-amber-500 font-extrabold uppercase tracking-wider">
                            {formatRoundName(match.round)} {match.group ? `• ${match.group}` : ""}
                          </span>
                          {isLive && (
                            <span className="text-[9px] bg-amber-500/15 border border-amber-500/30 text-amber-500 px-1.5 py-0.5 rounded font-bold flex items-center gap-1 animate-pulse">
                              <span className="w-1 h-1 rounded-full bg-amber-500 animate-ping"></span>
                              ⚡ En Juego
                            </span>
                          )}
                        </div>
                        <div className="font-extrabold text-sm text-slate-200 mt-1.5 flex items-center space-x-2 truncate">
                          {getFlagUrl(match.team1) && (
                            <img src={getFlagUrl(match.team1)!} alt={match.team1} className="w-5 h-3.5 object-cover rounded-sm border border-slate-900 shrink-0" />
                          )}
                          <span className="truncate">{match.team1}</span>
                          <span className="text-slate-500 font-bold text-xs shrink-0">vs</span>
                          <span className="truncate">{match.team2}</span>
                          {getFlagUrl(match.team2) && (
                            <img src={getFlagUrl(match.team2)!} alt={match.team2} className="w-5 h-3.5 object-cover rounded-sm border border-slate-900 shrink-0" />
                          )}
                        </div>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                        {/* Real result indicator */}
                        {(() => {
                          const isFinal = match.result !== null && match.result.isFinal !== false;

                          if (isFinal) {
                            return (
                              <span className="text-[11px] bg-slate-900/60 border border-slate-800 text-slate-300 px-2 py-1 rounded-lg font-bold">
                                Final: {match.result?.goals1} - {match.result?.goals2}
                              </span>
                            );
                          }

                          if (isLive) {
                            const liveGoals1 = match.result ? match.result.goals1 : 0;
                            const liveGoals2 = match.result ? match.result.goals2 : 0;
                            return (
                              <div className="flex items-center space-x-1.5 bg-slate-900/60 border border-slate-800 rounded-lg overflow-hidden">
                                <span className="text-[11px] text-slate-300 px-2 py-1 font-bold">
                                  En Vivo: <span className="text-amber-400">{liveGoals1} - {liveGoals2}</span>
                                </span>
                                <button
                                  onClick={() => refreshLiveMatchScore(match.id)}
                                  disabled={refreshingMatches[match.id]}
                                  title="Actualizar marcador en vivo"
                                  className="border-l border-slate-800 bg-slate-900/40 hover:bg-slate-800 text-amber-400 hover:text-amber-300 p-1.5 transition-all active:scale-[0.9] disabled:opacity-50 flex items-center justify-center"
                                >
                                  <svg
                                    className={`w-3 h-3 ${refreshingMatches[match.id] ? "animate-spin text-amber-500" : ""}`}
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    viewBox="0 0 24 24"
                                  >
                                    <path
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                      d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                                    />
                                  </svg>
                                </button>
                              </div>
                            );
                          }

                          return (
                            <span className="text-[10px] text-slate-500 font-semibold">{localTimeStr} {tzAbbr}</span>
                          );
                        })()}

                        {/* Prediction view */}
                        <div className="flex items-center gap-2 min-w-[90px] justify-end">
                          {hasStarted ? (
                            pred ? (
                              <div className="flex items-center gap-2">
                                <span className="text-xs bg-slate-900 border border-slate-800 text-amber-400 px-2 py-1 rounded-lg font-bold font-mono">
                                  {pred.goals1} - {pred.goals2}
                                </span>
                                <span className={`text-[10px] font-bold px-2 py-1 rounded-lg border ${getPointsBadgeClass(pts, isOld)}`}>
                                  +{pts} Pts {match.result?.isFinal === false ? "(Prov.)" : ""}
                                </span>
                              </div>
                            ) : (
                              <span className="text-[10px] text-rose-500 font-bold bg-rose-500/5 px-2.5 py-1 rounded-lg border border-rose-500/10">Sin pronóstico</span>
                            )
                          ) : (
                            <div className="flex items-center gap-1 text-[10px] text-slate-500 bg-slate-900/40 px-2.5 py-1 rounded-lg border border-slate-800/60 font-extrabold uppercase tracking-wider">
                              <span>🔒 Oculto</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                };

                const newMatches = filteredList.filter(m => m.date >= "2026-06-13");
                const oldMatches = filteredList.filter(m => m.date < "2026-06-13");

                return (
                  <div className="space-y-6">
                    {/* Fase Nueva */}
                    {newMatches.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-800/60 pb-2">
                          <h3 className="text-xs font-extrabold text-amber-400 flex items-center gap-1.5 uppercase tracking-wider">
                            <span>✨</span> Fase Nueva (Desde Jun 13)
                          </h3>
                          <span className="text-[10px] text-slate-500 font-medium">
                            Regla nueva: +5 Exacto, +3 Dif/Ganador, +1 Simple
                          </span>
                        </div>
                        <div className="space-y-3">
                          {newMatches.map(match => renderMatchRow(match))}
                        </div>
                      </div>
                    )}

                    {/* Fase Anterior */}
                    {oldMatches.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-slate-800/60 pb-2">
                          <h3 className="text-xs font-extrabold text-slate-400 flex items-center gap-1.5 uppercase tracking-wider">
                            <span>⏳</span> Fase Anterior (Hasta Jun 12)
                          </h3>
                          <span className="text-[10px] text-slate-500 font-medium">
                            Regla anterior: +1 Exacto (No aplica regla nueva)
                          </span>
                        </div>
                        <div className="space-y-3">
                          {oldMatches.map(match => renderMatchRow(match))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
            
            {/* Modal Footer */}
            <div className="pt-2 border-t border-slate-800 flex justify-end shrink-0">
              <button
                onClick={() => {
                  setViewingUser(null);
                  setViewingUserFilter("started");
                }}
                className="px-5 py-2.5 bg-slate-800 hover:bg-slate-750 text-slate-200 font-bold rounded-xl text-xs transition-all active:scale-[0.98]"
              >
                Cerrar
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Modal de Edición de Usuario por el Administrador */}
      {editingUser && editUserDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
          <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-200">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-lg font-black text-slate-100 flex items-center gap-2">
                <span>👤</span>
                <span>Editar Usuario</span>
              </h2>
              <button 
                onClick={() => {
                  setEditingUser(null);
                  setEditUserDraft(null);
                }}
                className="text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 w-8 h-8 rounded-full flex items-center justify-center transition-colors font-bold"
              >
                ✕
              </button>
            </div>

            {/* Modal Body / Inputs */}
            <div className="space-y-3.5 pt-2">
              <div>
                <label className="block text-[10px] font-extrabold text-slate-400 uppercase tracking-wider mb-1.5">Nombre Completo</label>
                <input 
                  type="text"
                  value={editUserDraft.displayName}
                  onChange={(e) => setEditUserDraft(prev => ({ ...prev!, displayName: e.target.value }))}
                  className="w-full h-11 px-4 bg-slate-950 border border-slate-800 focus:border-amber-500 text-sm rounded-xl focus:outline-none text-slate-200 font-medium"
                />
              </div>

              <div>
                <label className="block text-[10px] font-extrabold text-slate-400 uppercase tracking-wider mb-1.5">Correo Electrónico</label>
                <input 
                  type="email"
                  value={editUserDraft.email}
                  onChange={(e) => setEditUserDraft(prev => ({ ...prev!, email: e.target.value }))}
                  className="w-full h-11 px-4 bg-slate-950 border border-slate-800 focus:border-amber-500 text-sm rounded-xl focus:outline-none text-slate-200 font-medium"
                />
              </div>

              <div className="grid grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-[10px] font-extrabold text-slate-400 uppercase tracking-wider mb-1.5">Pts Fase Nueva</label>
                  <input 
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={editUserDraft.points}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9]/g, "");
                      setEditUserDraft(prev => ({ ...prev!, points: val }));
                    }}
                    className="w-full h-11 px-4 bg-slate-950 border border-slate-800 focus:border-amber-500 text-sm rounded-xl focus:outline-none text-slate-200 font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-extrabold text-slate-400 uppercase tracking-wider mb-1.5">Pts Fase Anterior</label>
                  <input 
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={editUserDraft.previousPoints}
                    onChange={(e) => {
                      const val = e.target.value.replace(/[^0-9]/g, "");
                      setEditUserDraft(prev => ({ ...prev!, previousPoints: val }));
                    }}
                    className="w-full h-11 px-4 bg-slate-950 border border-slate-800 focus:border-amber-500 text-sm rounded-xl focus:outline-none text-slate-200 font-bold"
                  />
                </div>
              </div>

              <div className="flex items-center gap-3 bg-slate-950 border border-slate-800 p-4 rounded-xl mt-4">
                <input 
                  type="checkbox"
                  id="isAdminCheckbox"
                  checked={editUserDraft.isAdmin}
                  onChange={(e) => setEditUserDraft(prev => ({ ...prev!, isAdmin: e.target.checked }))}
                  className="w-4.5 h-4.5 accent-amber-500 rounded bg-slate-900 border-slate-800 cursor-pointer"
                />
                <label htmlFor="isAdminCheckbox" className="text-xs font-bold text-slate-300 cursor-pointer select-none">
                  Otorgar permisos de Administrador
                </label>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="flex gap-3 pt-4 border-t border-slate-800/80">
              <button
                onClick={() => {
                  setEditingUser(null);
                  setEditUserDraft(null);
                }}
                className="flex-1 h-11 bg-slate-950 border border-slate-800 hover:bg-slate-900/80 text-slate-300 font-bold text-xs rounded-xl transition-all"
              >
                Cancelar
              </button>
              <button
                onClick={saveUserEditByAdmin}
                disabled={adminSavingUser || !editUserDraft.displayName.trim() || !editUserDraft.email.trim()}
                className="flex-1 h-11 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-extrabold text-xs rounded-xl transition-all shadow-lg shadow-amber-500/15"
              >
                {adminSavingUser ? "Guardando..." : "Guardar Cambios"}
              </button>
            </div>

          </div>
        </div>
      )}

      {/* Modal de Historial de Partidos de un Equipo */}
      {selectedTeamHistory && (() => {
        const teamMatches = matches
          .filter(
            (m) =>
              (m.team1 === selectedTeamHistory || m.team2 === selectedTeamHistory) &&
              m.result !== null
          )
          .sort((a, b) => {
            const dateA = getMatchDate(a).getTime();
            const dateB = getMatchDate(b).getTime();
            return dateB - dateA;
          });

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-955/85 backdrop-blur-md animate-in fade-in duration-200">
            <div className="bg-slate-900/90 border border-slate-800 rounded-3xl p-6 max-w-lg w-full shadow-2xl space-y-4 animate-in fade-in zoom-in-95 duration-200 max-h-[85vh] flex flex-col">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-slate-800 pb-4 shrink-0">
                <div className="flex items-center space-x-3">
                  {getFlagUrl(selectedTeamHistory) && (
                    <img
                      src={getFlagUrl(selectedTeamHistory)!}
                      alt={selectedTeamHistory}
                      className="w-10 h-7 object-cover rounded shadow-md border border-slate-955"
                    />
                  )}
                  <div>
                    <h2 className="text-lg sm:text-xl font-black text-slate-100">
                      {selectedTeamHistory}
                    </h2>
                    <p className="text-xs text-slate-400">Historial en el Mundial</p>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedTeamHistory(null)}
                  className="text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 w-8 h-8 rounded-full flex items-center justify-center transition-colors font-bold cursor-pointer"
                >
                  ✕
                </button>
              </div>

              {/* Match list */}
              <div className="flex-1 overflow-y-auto space-y-3 pr-1 scrollbar-thin scrollbar-thumb-slate-800">
                {teamMatches.length === 0 ? (
                  <div className="text-center py-12 text-slate-500 text-sm flex flex-col items-center justify-center gap-2">
                    <span className="text-2xl">⚽</span>
                    <p>Este equipo aún no ha jugado partidos finalizados en este mundial.</p>
                  </div>
                ) : (
                  teamMatches.map((m) => {
                    const isTeam1 = m.team1 === selectedTeamHistory;
                    const teamGoals = isTeam1 ? m.result!.goals1 : m.result!.goals2;
                    const oppGoals = isTeam1 ? m.result!.goals2 : m.result!.goals1;
                    const oppName = isTeam1 ? m.team2 : m.team1;

                    let outcome: "win" | "draw" | "loss";
                    if (teamGoals > oppGoals) outcome = "win";
                    else if (teamGoals < oppGoals) outcome = "loss";
                    else outcome = "draw";

                    const outcomeConfig = {
                      win: {
                        label: "Victoria",
                        classes: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
                        dot: "bg-emerald-400",
                      },
                      draw: {
                        label: "Empate",
                        classes: "bg-slate-500/10 border-slate-500/30 text-slate-400",
                        dot: "bg-slate-400",
                      },
                      loss: {
                        label: "Derrota",
                        classes: "bg-rose-500/10 border-rose-500/30 text-rose-400",
                        dot: "bg-rose-400",
                      },
                    }[outcome];

                    const matchDate = getMatchDate(m);
                    const formattedDate = matchDate.toLocaleDateString(undefined, {
                      day: "numeric",
                      month: "short",
                    });

                    return (
                      <div
                        key={m.id}
                        className="bg-slate-950/40 border border-slate-850/80 rounded-2xl p-4 flex flex-col gap-3 hover:bg-slate-955/80 transition-all"
                      >
                        {/* Match header info */}
                        <div className="flex items-center justify-between text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                          <span>{formatRoundName(m.round)}</span>
                          <span>{formattedDate}</span>
                        </div>

                        {/* Match Content */}
                        <div className="flex items-center justify-between gap-3">
                          {/* Selected Team */}
                          <div className="flex-1 flex items-center gap-2 min-w-0">
                            {getFlagUrl(selectedTeamHistory) && (
                              <img
                                src={getFlagUrl(selectedTeamHistory)!}
                                alt={selectedTeamHistory}
                                className="w-5 h-3.5 object-cover rounded-sm border border-slate-955 shrink-0"
                              />
                            )}
                            <span className="font-extrabold text-xs sm:text-sm text-slate-200 truncate">
                              {selectedTeamHistory}
                            </span>
                          </div>

                          {/* Score and result badge */}
                          <div className="flex flex-col items-center shrink-0">
                            <span className="text-sm font-black text-slate-100 bg-slate-950 border border-slate-800/80 px-2.5 py-1 rounded-xl">
                              {teamGoals} - {oppGoals}
                            </span>
                            <span className={`inline-flex items-center gap-1 text-[9px] font-extrabold px-1.5 py-0.5 rounded border mt-1.5 ${outcomeConfig.classes}`}>
                              <span className={`w-1 h-1 rounded-full ${outcomeConfig.dot}`}></span>
                              {outcomeConfig.label}
                            </span>
                          </div>

                          {/* Opponent */}
                          <div className="flex-1 flex items-center justify-end gap-2 min-w-0">
                            <span className="font-semibold text-xs sm:text-sm text-slate-400 truncate text-right">
                              {oppName}
                            </span>
                            {getFlagUrl(oppName) && (
                              <img
                                src={getFlagUrl(oppName)!}
                                alt={oppName}
                                className="w-5 h-3.5 object-cover rounded-sm border border-slate-955 shrink-0"
                              />
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Footer */}
              <div className="pt-2 border-t border-slate-800 flex justify-end shrink-0">
                <button
                  onClick={() => setSelectedTeamHistory(null)}
                  className="px-5 py-2.5 bg-slate-800 hover:bg-slate-750 text-slate-200 font-bold rounded-xl text-xs transition-all active:scale-[0.98] cursor-pointer"
                >
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
