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
  writeBatch 
} from "firebase/firestore";
import { db } from "@/lib/firebase";
import { calculatePoints } from "@/lib/scoreCalculator";
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
  isAdmin?: boolean;
}

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
    removeSavedAccount 
  } = useAuth();
  
  // Auth state inputs
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  // Tabs: 'matches', 'leaderboard', 'admin'
  const [activeTab, setActiveTab] = useState<"matches" | "leaderboard" | "admin">("matches");
  
  // Data lists
  const [matches, setMatches] = useState<Match[]>([]);
  const [predictions, setPredictions] = useState<{ [matchId: string]: Prediction }>({});
  const [allPredictions, setAllPredictions] = useState<Prediction[]>([]);
  const [leaderboard, setLeaderboard] = useState<UserProfile[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  // Filter & prediction draft inputs
  const [selectedRound, setSelectedRound] = useState<string>("Todos");
  const [predictionDrafts, setPredictionDrafts] = useState<{ [matchId: string]: { goals1: string; goals2: string } }>({});
  const [savingMatches, setSavingMatches] = useState<{ [matchId: string]: boolean }>({});

  // Admin inputs
  const [adminResults, setAdminResults] = useState<{ [matchId: string]: { goals1: string; goals2: string; isFinal: boolean } }>({});
  const [adminSaving, setAdminSaving] = useState<{ [matchId: string]: boolean }>({});
  const [adminSubTab, setAdminSubTab] = useState<"results" | "predictions">("results");
  const [adminSelectedUserId, setAdminSelectedUserId] = useState<string>("");
  const [adminUserPredictions, setAdminUserPredictions] = useState<{ [matchId: string]: Prediction }>({});
  const [adminUserDrafts, setAdminUserDrafts] = useState<{ [matchId: string]: { goals1: string; goals2: string } }>({});
  const [adminSavingUserPreds, setAdminSavingUserPreds] = useState<{ [matchId: string]: boolean }>({});
  const [adminRecalculating, setAdminRecalculating] = useState(false);

  // Auth Handler
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

  // Real-time data sync
  useEffect(() => {
    if (!user) return;

    setDataLoading(true);
    setPredictions({});
    setPredictionDrafts({});

    // 1. Sync Matches
    const qMatches = query(collection(db, "matches"), orderBy("num", "asc"));
    const unsubMatches = onSnapshot(qMatches, (snapshot) => {
      const list: Match[] = [];
      const adminDrafts: { [matchId: string]: { goals1: string; goals2: string; isFinal: boolean } } = {};
      snapshot.forEach((doc) => {
        const m = doc.data() as Match;
        list.push({ ...m, id: doc.id });
        if (m.result) {
          adminDrafts[doc.id] = {
            goals1: String(m.result.goals1),
            goals2: String(m.result.goals2),
            isFinal: m.result.isFinal ?? true
          };
        } else {
          adminDrafts[doc.id] = {
            goals1: "",
            goals2: "",
            isFinal: true
          };
        }
      });
      setMatches(list);
      setAdminResults((prev) => ({ ...adminDrafts, ...prev }));
    });

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
      unsubMatches();
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
        pts = calculatePoints(g1, g2, match.result.goals1, match.result.goals2);
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
      let totalPoints = 0;
      allPredsSnap.forEach((pDoc) => {
        const pred = pDoc.data() as Prediction;
        if (pred.userId === adminSelectedUserId) {
          totalPoints += pred.points || 0;
        }
      });

      await setDoc(doc(db, "users", adminSelectedUserId), {
        points: totalPoints
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
        pts = calculatePoints(g1, g2, match.result.goals1, match.result.goals2);
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

      predSnap.forEach((pDoc) => {
        const pred = pDoc.data() as Prediction;
        if (pred.matchId === matchId) {
          const pts = calculatePoints(pred.goals1, pred.goals2, rg1, rg2);
          batch.update(doc(db, "predictions", pred.id), { points: pts });
          updatedUserIds.add(pred.userId);
        }
      });

      // Commit predictions updates
      await batch.commit();

      // 3. Recalculate users points
      const allPredsSnap = await getDocs(collection(db, "predictions"));
      const userPointsMap: { [userId: string]: number } = {};
      
      allPredsSnap.forEach((pDoc) => {
        const pred = pDoc.data() as Prediction;
        if (!userPointsMap[pred.userId]) {
          userPointsMap[pred.userId] = 0;
        }
        userPointsMap[pred.userId] += pred.points || 0;
      });

      // Update users collection
      const userBatch = writeBatch(db);
      Object.keys(userPointsMap).forEach((uid) => {
        userBatch.update(doc(db, "users", uid), { points: userPointsMap[uid] });
      });
      await userBatch.commit();

      alert("Resultado guardado y puntajes recalculados exitosamente.");
    } catch (err) {
      console.error("Error setting match result:", err);
      alert("Error al guardar resultado.");
    } finally {
      setAdminSaving(prev => ({ ...prev, [matchId]: false }));
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
      const batch = writeBatch(db);

      predsSnap.forEach(pDoc => {
        const pred = pDoc.data() as Prediction;
        const match = matchesMap[pred.matchId];
        
        let pts = 0;
        if (match && match.result) {
          pts = calculatePoints(pred.goals1, pred.goals2, match.result.goals1, match.result.goals2);
        }

        if (pred.points !== pts) {
          batch.update(doc(db, "predictions", pred.id), { points: pts });
        }

        if (!userPointsMap[pred.userId]) {
          userPointsMap[pred.userId] = 0;
        }
        userPointsMap[pred.userId] += pts;
      });

      const usersSnap = await getDocs(collection(db, "users"));
      usersSnap.forEach(uDoc => {
        const uid = uDoc.id;
        const pts = userPointsMap[uid] || 0;
        batch.update(doc(db, "users", uid), { points: pts });
      });

      await batch.commit();
      alert("¡Todos los puntajes de las predicciones y de los usuarios han sido recalculados y guardados con éxito en la base de datos!");
    } catch (err) {
      console.error("Error recalculating all scores:", err);
      alert("Error al recalcular todos los puntajes en Firestore.");
    } finally {
      setAdminRecalculating(false);
    }
  };

  // Compute financial metrics dynamically in real-time
  const financialStats = React.useMemo(() => {
    const sortedMatches = [...matches].sort((a, b) => a.num - b.num);

    const stats: { 
      [userId: string]: { 
        invested: number; 
        winnings: number; 
        balance: number; 
        predictionsCount: number;
      } 
    } = {};

    // Ensure all users in leaderboard are initialized
    leaderboard.forEach(u => {
      stats[u.uid] = { invested: 0, winnings: 0, balance: 0, predictionsCount: 0 };
    });

    let rollover = 0;

    sortedMatches.forEach(match => {
      if (!match.result) return;

      const matchPreds = allPredictions.filter(p => p.matchId === match.id);
      if (matchPreds.length === 0) return;

      matchPreds.forEach(pred => {
        if (!stats[pred.userId]) {
          stats[pred.userId] = { invested: 0, winnings: 0, balance: 0, predictionsCount: 0 };
        }
        stats[pred.userId].predictionsCount += 1;
        stats[pred.userId].invested += 500;
      });

      const totalPoolForMatch = (matchPreds.length * 500) + rollover;

      const winners = matchPreds.filter(pred => 
        pred.goals1 === match.result!.goals1 && pred.goals2 === match.result!.goals2
      );

      if (winners.length > 0) {
        const winAmountPerUser = totalPoolForMatch / winners.length;
        winners.forEach(winner => {
          stats[winner.userId].winnings += winAmountPerUser;
        });
        rollover = 0;
      } else {
        rollover = totalPoolForMatch;
      }
    });

    Object.keys(stats).forEach(uid => {
      stats[uid].balance = stats[uid].winnings - stats[uid].invested;
    });

    return { stats, currentRollover: rollover };
  }, [matches, allPredictions, leaderboard]);

  // Unique list of rounds for filtering
  const rounds = ["Todos", "Matchday 1", "Matchday 2", "Matchday 3", "Matchday 4", "Matchday 5", "Matchday 6", "Matchday 7", "Matchday 8", "Matchday 9", "Matchday 10", "Matchday 11", "Matchday 12", "Matchday 13", "Matchday 14", "Matchday 15", "Matchday 16", "Matchday 17", "Round of 32", "Round of 16", "Quarter-final", "Semi-final", "Match for third place", "Final"];

  const filteredMatches = selectedRound === "Todos" 
    ? matches 
    : matches.filter(m => m.round === selectedRound);

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-slate-950 text-white p-6">
        <div className="w-16 h-16 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
        <p className="mt-4 text-slate-400 font-medium animate-pulse">Cargando polla mundialista...</p>
      </div>
    );
  }

  // Not logged in: Show auth screen
  if (!user) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-slate-900 via-slate-950 to-black">
        <div className="w-full max-w-md bg-slate-900/60 backdrop-blur-xl border border-slate-800/80 rounded-2xl shadow-2xl p-8 transition-all duration-300">
          <div className="text-center mb-8">
            <span className="text-5xl mb-2 block animate-bounce">🏆</span>
            <h1 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-emerald-400 via-teal-300 to-amber-300 bg-clip-text text-transparent">
              Polla Mundial 2026
            </h1>
            <p className="text-emerald-450 font-extrabold text-xs tracking-wider mt-1.5 uppercase text-emerald-400">
              Familia Güiza • Ardila • Franco y otros jajaja
            </p>
            <p className="text-slate-400 text-sm mt-2">
              {isRegistering ? "Regístrate para pronosticar los 104 partidos" : "Inicia sesión para ver tu puntaje y pronósticos"}
            </p>
          </div>

          {savedAccounts.length > 0 && !isRegistering && (
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
                      <span className="font-bold text-xs text-slate-200 group-hover:text-emerald-400 transition-colors">
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
                  className="w-full px-4 py-3 bg-slate-950/50 border border-slate-800 rounded-xl focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 text-slate-100 transition-colors"
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
                className="w-full px-4 py-3 bg-slate-950/50 border border-slate-800 rounded-xl focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 text-slate-100 transition-colors"
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
                className="w-full px-4 py-3 bg-slate-950/50 border border-slate-800 rounded-xl focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 text-slate-100 transition-colors"
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
              className="w-full py-3 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-400 hover:to-teal-500 text-slate-950 font-bold rounded-xl shadow-lg hover:shadow-emerald-500/20 active:scale-[0.98] transition-all duration-200 flex items-center justify-center disabled:opacity-50"
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

          <div className="mt-6 text-center">
            <button
              onClick={() => {
                setIsRegistering(!isRegistering);
                setAuthError("");
              }}
              className="text-emerald-400 hover:text-emerald-300 text-sm font-medium transition-colors"
            >
              {isRegistering ? "¿Ya tienes cuenta? Inicia Sesión" : "¿No tienes cuenta? Regístrate aquí"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Logged in user dashboard
  return (
    <div className="flex-1 flex flex-col bg-slate-950 min-h-screen overflow-x-hidden">
      {/* Header */}
      <header className="bg-slate-900/40 backdrop-blur-md border-b border-slate-900 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="text-2xl">🏆</span>
            <div className="hidden sm:flex flex-col">
              <span className="font-extrabold text-base sm:text-lg bg-gradient-to-r from-emerald-400 to-amber-300 bg-clip-text text-transparent leading-none">
                Polla Mundial 2026
              </span>
              <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider mt-0.5 leading-none">
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
              <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-full px-4 py-1.5 flex items-center space-x-1.5">
                <span className="text-amber-400 font-bold">⭐</span>
                <span className="font-extrabold text-emerald-400 text-sm">{profile?.points ?? 0} Pts</span>
              </div>

              {user && financialStats.stats[user.uid] && (
                <div className="hidden md:flex items-center space-x-3 bg-slate-900/60 border border-slate-800 rounded-full px-4 py-1.5 text-[11px] text-slate-350">
                  <span>Debe aportar: <strong className="text-slate-200">${financialStats.stats[user.uid].invested} COP</strong></span>
                  <span className="text-slate-700">|</span>
                  <span>Premios Ganados: <strong className="text-emerald-400">${financialStats.stats[user.uid].winnings.toFixed(0)} COP</strong></span>
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
            className={`flex-1 lg:flex-none lg:w-full px-4 py-3 rounded-xl font-bold text-sm text-center lg:text-left flex items-center justify-center lg:justify-start space-x-2.5 transition-all shrink-0 ${
              activeTab === "matches" 
                ? "bg-gradient-to-r from-emerald-500/20 to-teal-500/10 border-b-2 lg:border-b-0 lg:border-l-4 border-emerald-500 text-emerald-400" 
                : "bg-slate-900/40 hover:bg-slate-900/80 text-slate-400 hover:text-slate-200 border-b-2 border-transparent lg:border-b-0"
            }`}
          >
            <span>📅</span>
            <span>Pronósticos</span>
          </button>

          <button
            onClick={() => setActiveTab("leaderboard")}
            className={`flex-1 lg:flex-none lg:w-full px-4 py-3 rounded-xl font-bold text-sm text-center lg:text-left flex items-center justify-center lg:justify-start space-x-2.5 transition-all shrink-0 ${
              activeTab === "leaderboard" 
                ? "bg-gradient-to-r from-emerald-500/20 to-teal-500/10 border-b-2 lg:border-b-0 lg:border-l-4 border-emerald-500 text-emerald-400" 
                : "bg-slate-900/40 hover:bg-slate-900/80 text-slate-400 hover:text-slate-200 border-b-2 border-transparent lg:border-b-0"
            }`}
          >
            <span>🏆</span>
            <span>Posiciones</span>
          </button>

          {profile?.isAdmin && (
            <button
              onClick={() => setActiveTab("admin")}
              className={`flex-1 lg:flex-none lg:w-full px-4 py-3 rounded-xl font-bold text-sm text-center lg:text-left flex items-center justify-center lg:justify-start space-x-2.5 transition-all shrink-0 ${
                activeTab === "admin" 
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
              <div className="w-10 h-10 border-3 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="mt-3 text-slate-500 text-sm animate-pulse">Obteniendo datos de Firebase...</p>
            </div>
          ) : (
            <>
              {/* TAB: PRONÓSTICOS */}
              {activeTab === "matches" && (
                <div className="space-y-6">
                  {/* Round Filter */}
                  <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                    <div>
                      <h2 className="text-xl font-extrabold text-slate-200">Calendario Oficial</h2>
                      <p className="text-slate-400 text-xs">Completa tus predicciones de los 104 partidos del Mundial</p>
                    </div>

                    <select
                      value={selectedRound}
                      onChange={(e) => setSelectedRound(e.target.value)}
                      className="px-4 py-2 bg-slate-950 border border-slate-800 text-slate-300 text-sm rounded-xl focus:outline-none focus:border-emerald-500"
                    >
                      {rounds.map((round) => (
                        <option key={round} value={round}>{round}</option>
                      ))}
                    </select>
                  </div>

                  {/* Matches Grid */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {filteredMatches.length === 0 ? (
                      <div className="col-span-full py-12 text-center text-slate-500">
                        No se encontraron partidos para esta ronda.
                      </div>
                    ) : (
                      filteredMatches.map((match) => {
                        const pred = predictions[match.id];
                        const draft = predictionDrafts[match.id] || { goals1: "", goals2: "" };
                        const isSaving = savingMatches[match.id];
                        const hasResult = match.result !== null;

                        return (
                          <div 
                            key={match.id}
                            className="bg-slate-900/40 hover:bg-slate-900/60 transition-all border border-slate-900/80 hover:border-slate-800 rounded-2xl p-5 flex flex-col justify-between"
                          >
                            {/* Match Header */}
                            <div className="flex justify-between items-center text-xs text-slate-400 border-b border-slate-950/60 pb-3 mb-4">
                              <span className="font-bold text-emerald-500">{match.round} {match.group ? `• ${match.group}` : ""}</span>
                              <span>{match.date} • {match.time.split(" ")[0]}</span>
                            </div>

                            {/* Teams and Inputs */}
                            <div className="flex items-center justify-between gap-3 my-2">
                              {/* Team 1 */}
                              <div className="flex-1 flex items-center justify-end space-x-2 font-bold text-sm sm:text-base text-slate-200 truncate">
                                <span className="truncate">{match.team1}</span>
                                {getFlagUrl(match.team1) && (
                                  <img 
                                    src={getFlagUrl(match.team1)!} 
                                    alt={match.team1} 
                                    className="w-6 h-4 object-cover rounded-sm shadow-sm border border-slate-900 shrink-0"
                                  />
                                )}
                              </div>

                              {/* Prediction / Score inputs */}
                              <div className="flex items-center space-x-2">
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  value={draft.goals1}
                                  disabled={hasResult || isSaving}
                                  onChange={(e) => {
                                    const val = e.target.value.replace(/[^0-9]/g, "");
                                    setPredictionDrafts(prev => ({
                                      ...prev,
                                      [match.id]: { ...draft, goals1: val }
                                    }));
                                  }}
                                  className="w-12 h-12 text-center bg-slate-950 border border-slate-800 focus:border-emerald-500 text-lg font-extrabold rounded-xl focus:outline-none disabled:opacity-60 disabled:bg-slate-900/30 text-emerald-400"
                                  placeholder="-"
                                />
                                <span className="text-slate-600 font-bold">vs</span>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  value={draft.goals2}
                                  disabled={hasResult || isSaving}
                                  onChange={(e) => {
                                    const val = e.target.value.replace(/[^0-9]/g, "");
                                    setPredictionDrafts(prev => ({
                                      ...prev,
                                      [match.id]: { ...draft, goals2: val }
                                    }));
                                  }}
                                  className="w-12 h-12 text-center bg-slate-950 border border-slate-800 focus:border-emerald-500 text-lg font-extrabold rounded-xl focus:outline-none disabled:opacity-60 disabled:bg-slate-900/30 text-emerald-400"
                                  placeholder="-"
                                />
                              </div>

                              {/* Team 2 */}
                              <div className="flex-1 flex items-center justify-start space-x-2 font-bold text-sm sm:text-base text-slate-200 truncate">
                                {getFlagUrl(match.team2) && (
                                  <img 
                                    src={getFlagUrl(match.team2)!} 
                                    alt={match.team2} 
                                    className="w-6 h-4 object-cover rounded-sm shadow-sm border border-slate-900 shrink-0"
                                  />
                                )}
                                <span className="truncate">{match.team2}</span>
                              </div>
                            </div>

                            {/* Match Footer */}
                            <div className="mt-4 pt-3 border-t border-slate-950/60 flex items-center justify-between">
                              <span className="text-[10px] text-slate-500 truncate max-w-[150px]">
                                {match.ground}
                              </span>

                              {hasResult ? (
                                <div className="flex items-center space-x-2">
                                  <span className="text-xs bg-slate-950 border border-slate-800 text-slate-400 px-2.5 py-1 rounded-lg">
                                    {match.result?.isFinal === false ? "En Vivo: " : "Final: "}{match.result?.goals1} - {match.result?.goals2}
                                  </span>
                                  <span className={`text-xs font-bold px-2 py-1 rounded-lg ${
                                    (pred?.points ?? 0) === 1 
                                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                                      : "bg-slate-800 text-slate-500"
                                  }`}>
                                    +{pred?.points ?? 0} Pts {match.result?.isFinal === false ? "(Prov.)" : ""}
                                  </span>
                                </div>
                              ) : (
                                <button
                                  onClick={() => savePrediction(match.id)}
                                  disabled={isSaving || draft.goals1 === "" || draft.goals2 === ""}
                                  className="px-4 py-1.5 bg-emerald-500 hover:bg-emerald-400 disabled:bg-slate-850 disabled:text-slate-600 disabled:border-slate-800/80 text-slate-950 font-bold text-xs rounded-xl transition-all shadow-md active:scale-[0.95]"
                                >
                                  {isSaving ? "Guardando..." : pred ? "Actualizar" : "Guardar"}
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {/* TAB: LEADERBOARD */}
              {activeTab === "leaderboard" && (
                <div className="space-y-6">
                  <div className="bg-slate-900/40 border border-slate-900 rounded-2xl p-6">
                    <h2 className="text-xl font-extrabold text-slate-200">Tabla de Clasificación</h2>
                    <p className="text-slate-400 text-xs mt-1">Conoce a los mejores pronosticadores de la copa</p>
                    
                    {financialStats.currentRollover > 0 && (
                      <div className="mt-4 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs px-4 py-3 rounded-xl flex items-center justify-between">
                        <span>💰 <strong>Bolsa Acumulada:</strong> Nadie acertó el marcador exacto en el último partido. El pozo acumulado para el próximo partido es de <strong>${financialStats.currentRollover} COP</strong>.</span>
                      </div>
                    )}

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
                          {leaderboard.map((userProf, index) => {
                            const isMe = userProf.uid === user.uid;
                            const userStats = financialStats.stats[userProf.uid] || { invested: 0, winnings: 0, balance: 0, predictionsCount: 0 };
                            return (
                              <tr 
                                key={userProf.uid} 
                                className={`text-xs sm:text-sm hover:bg-slate-900/20 transition-colors ${
                                  isMe ? "bg-emerald-500/5 text-emerald-400 font-bold" : "text-slate-300"
                                }`}
                              >
                                <td className="py-3 sm:py-4 px-3 sm:px-6 text-center font-extrabold">
                                  {index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : index + 1}
                                </td>
                                <td className="py-3 sm:py-4 px-3 sm:px-6 truncate max-w-[120px] sm:max-w-[200px]">
                                  {userProf.displayName} {isMe && <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.5 rounded ml-2">Tú</span>}
                                </td>
                                <td className="py-3 sm:py-4 px-3 sm:px-6 text-center text-slate-400">
                                  {userStats.predictionsCount}
                                </td>
                                <td className="py-3 sm:py-4 px-3 sm:px-6 text-right text-slate-400">
                                  ${userStats.invested}
                                </td>
                                <td className="py-3 sm:py-4 px-3 sm:px-6 text-right text-emerald-400">
                                  ${userStats.winnings.toFixed(0)}
                                </td>
                                <td className="py-3 sm:py-4 px-3 sm:px-6 text-right font-extrabold text-emerald-400">
                                  {userProf.points}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
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
                        className={`px-4 py-2 rounded-xl text-xs font-extrabold transition-all border ${
                          adminSubTab === "results"
                            ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                            : "bg-slate-950/40 border-slate-900 text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        ⚽ Resultados del Mundial
                      </button>
                      <button
                        onClick={() => setAdminSubTab("predictions")}
                        className={`px-4 py-2 rounded-xl text-xs font-extrabold transition-all border ${
                          adminSubTab === "predictions"
                            ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                            : "bg-slate-950/40 border-slate-900 text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        👤 Pronósticos de Jugadores
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
                        <select
                          value={selectedRound}
                          onChange={(e) => setSelectedRound(e.target.value)}
                          className="px-4 py-2 bg-slate-950 border border-slate-800 text-slate-300 text-sm rounded-xl focus:outline-none focus:border-amber-500"
                        >
                          {rounds.map((round) => (
                            <option key={round} value={round}>{round}</option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-4">
                        {filteredMatches.length === 0 ? (
                          <div className="py-12 text-center text-slate-500">
                            No se encontraron partidos para esta ronda.
                          </div>
                        ) : (
                          filteredMatches.map((match) => {
                            const draft = adminResults[match.id] || { goals1: "", goals2: "" };
                            const isSaving = adminSaving[match.id];
                            
                            return (
                              <div 
                                key={match.id}
                                className="bg-slate-900/40 border border-slate-900/80 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
                              >
                                <div className="flex-1">
                                  <span className="text-xs text-amber-500 font-semibold">{match.round} • Partido {match.num}</span>
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
                                  <span className="text-[10px] text-slate-500">{match.ground} • {match.date}</span>
                                </div>

                                <div className="flex items-center space-x-3">
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    value={draft.goals1}
                                    onChange={(e) => {
                                      const val = e.target.value.replace(/[^0-9]/g, "");
                                      setAdminResults(prev => ({
                                        ...prev,
                                        [match.id]: { ...draft, goals1: val }
                                      }));
                                    }}
                                    className="w-12 h-10 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-md font-bold rounded-lg focus:outline-none text-amber-400"
                                    placeholder={match.result ? String(match.result.goals1) : "-"}
                                  />
                                  <span className="text-slate-600 font-bold">vs</span>
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    value={draft.goals2}
                                    onChange={(e) => {
                                      const val = e.target.value.replace(/[^0-9]/g, "");
                                      setAdminResults(prev => ({
                                        ...prev,
                                        [match.id]: { ...draft, goals2: val }
                                      }));
                                    }}
                                    className="w-12 h-10 text-center bg-slate-950 border border-slate-800 focus:border-amber-500 text-md font-bold rounded-lg focus:outline-none text-amber-400"
                                    placeholder={match.result ? String(match.result.goals2) : "-"}
                                  />

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
                          })
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
                          <select
                            value={selectedRound}
                            onChange={(e) => setSelectedRound(e.target.value)}
                            className="w-full md:w-64 px-4 py-2.5 bg-slate-950 border border-slate-800 text-slate-300 text-sm rounded-xl focus:outline-none focus:border-amber-500"
                          >
                            {rounds.map((round) => (
                              <option key={round} value={round}>{round}</option>
                            ))}
                          </select>
                        </div>
                      </div>

                      {/* User Matches Grid */}
                      {!adminSelectedUserId ? (
                        <div className="text-center py-16 bg-slate-900/20 border border-slate-900/50 rounded-2xl text-slate-500">
                          <span className="text-4xl block mb-2">👤</span>
                          Por favor, selecciona un jugador de la lista superior para visualizar y editar sus pronósticos.
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {filteredMatches.length === 0 ? (
                            <div className="py-12 text-center text-slate-500">
                              No se encontraron partidos para esta ronda.
                            </div>
                          ) : (
                            filteredMatches.map((match) => {
                              const pred = adminUserPredictions[match.id];
                              const draft = adminUserDrafts[match.id] || { goals1: "", goals2: "" };
                              const isSaving = adminSavingUserPreds[match.id];
                              const hasResult = match.result !== null;

                              return (
                                <div 
                                  key={match.id}
                                  className="bg-slate-900/40 border border-slate-900/80 rounded-2xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4"
                                >
                                  {/* Match Team Info */}
                                  <div className="flex-1">
                                    <span className="text-xs text-amber-500 font-semibold">{match.round} • Partido {match.num}</span>
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
                                      <span className="text-[10px] text-slate-500">{match.date} • {match.ground}</span>
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
                                      <span className="text-slate-600 font-bold text-xs">vs</span>
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
                                      <span className={`text-xs font-bold px-2 py-1.5 rounded-lg border ${
                                        pred.points === 1 
                                          ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" 
                                          : "bg-slate-800 text-slate-500 border-transparent"
                                      }`}>
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
                            })
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
