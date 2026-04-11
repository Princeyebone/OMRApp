import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet,
  View,
  ScrollView,
  BackHandler,
  Alert,
} from 'react-native';
import {
  Text,
  Card,
  Button,
  Avatar,
  useTheme,
  Dialog,
  Portal,
  List,
  Surface,
  Snackbar,
  TextInput,
  Chip,
  Divider,
  SegmentedButtons,
} from 'react-native-paper';
import CameraScanner from '../../components/CameraScanner';
import {
  initDatabase,
  saveSession,
  getAllSessions,
  getSession,
  saveResult,
  getResultsForSession,
  deleteSession,
} from '../../db/database';
import { OMRProcessor, GridConfig, MarkingResult } from '../../algorithm/omrProcessor';

// ─── View states ─────────────────────────────────────────────────────────────
type AppView = 'home' | 'newSession' | 'sessions' | 'sessionDetail' | 'camera' | 'editSession';
type CameraMode = 'learn' | 'mark';

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E'];

const HomeScreen = () => {
  const theme = useTheme();

  // ── State ─────────────────────────────────────────────────────────────────
  const [view, setView]                       = useState<AppView>('home');
  const [cameraMode, setCameraMode]           = useState<CameraMode>('learn');
  const [loading, setLoading]                 = useState(false);
  const [progressText, setProgressText]       = useState('');
  const [errorMessage, setErrorMessage]       = useState('');
  const [snackbarVisible, setSnackbarVisible] = useState(false);

  // New session setup
  const [sessionName, setSessionName]         = useState('');
  const [bubblesPerQ, setBubblesPerQ]         = useState('4');
  const [answerKey, setAnswerKey]             = useState<string[]>([]);
  const [answerKeyText, setAnswerKeyText]     = useState(''); // comma-separated

  // Session list
  const [sessions, setSessions]               = useState<any[]>([]);
  const [activeSession, setActiveSession]     = useState<any | null>(null);

  // Result dialog
  const [showResult, setShowResult]           = useState(false);
  const [lastResult, setLastResult]           = useState<MarkingResult>({});
  const [lastScore, setLastScore]             = useState<number | null>(null);
  const [lastStats, setLastStats]             = useState({ correct: 0, incorrect: 0, skipped: 0 });
  const [sessionResults, setSessionResults]   = useState<any[]>([]);
  const [editSessionId, setEditSessionId]     = useState<string | null>(null);
  
  // Ref to track if the current processing should be cancelled
  const isCancelledRef = useRef(false);

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    initDatabase();
    refreshSessions();
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (view === 'camera')      { setView(activeSession ? 'sessionDetail' : 'home'); return true; }
      if (view === 'editSession') { setView('sessionDetail'); return true; }
      if (view !== 'home')   { setView('home'); return true; }
      return false;
    });
    return () => sub.remove();
  }, [view, activeSession]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const showError = (msg: string) => { setErrorMessage(msg); setSnackbarVisible(true); };
  const refreshSessions = () => setSessions(getAllSessions());
  const parseAnswerKey = (text: string): string[] =>
    text.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

  // ── Camera capture handler ────────────────────────────────────────────────
  const handleCapture = useCallback(async (photoUri: string) => {
    // Preserve current view so button progress text is visible
    if (cameraMode === 'learn') setView('newSession');
    else setView('sessionDetail');
    
    setLoading(true);
    isCancelledRef.current = false; // Reset cancellation state
    const cleanPath = photoUri.replace('file://', '');

    try {
      if (cameraMode === 'learn') {
        // ── Phase 1: Learn grid from template photo ─────────────────────────
        const bpq = parseInt(bubblesPerQ, 10) || 4;
        const config: GridConfig = await OMRProcessor.learnGrid(
          cleanPath,
          bpq,
          msg => {
            if (msg) setProgressText(msg);
            return isCancelledRef.current;
          },
        );

        if (isCancelledRef.current) return;

        const id  = `session_${Date.now()}`;
        const key = parseAnswerKey(answerKeyText);
        saveSession(id, sessionName.trim() || `Session ${id}`, config, key);
        
        if (isCancelledRef.current) return;
        refreshSessions();

        const sess = getSession(id);
        setActiveSession(sess);
        setSessionResults([]);
        setView('sessionDetail');

      } else {
        // ── Phase 2: Mark a sheet using saved grid ──────────────────────────
        if (!activeSession) { showError('No active session.'); return; }
        const key: string[] = activeSession.answerKey ?? [];

        const summary = await OMRProcessor.markSheet(
          cleanPath,
          activeSession.config,
          key,
          msg => {
            if (msg) setProgressText(msg);
            return isCancelledRef.current;
          },
        );

        if (isCancelledRef.current) return;

        saveResult(activeSession.id, summary.results, summary.score, activeSession.config.totalQuestions);
        
        if (isCancelledRef.current) return;

        setLastResult(summary.results);
        setLastScore(summary.score);
        setLastStats({ correct: summary.correct, incorrect: summary.incorrect, skipped: summary.skipped });
        setSessionResults(getResultsForSession(activeSession.id));
        setShowResult(true);
      }
    } catch (err: any) {
      if (!isCancelledRef.current && err?.message !== 'CANCELLED') {
        console.error('[OMR Error]', err);
        showError(err?.message ?? 'An error occurred. Please try again.');
      }
    } finally {
      setLoading(false);
      setProgressText('');
    }
  }, [cameraMode, bubblesPerQ, sessionName, answerKeyText, activeSession]);

  const handleUpdateSession = () => {
    if (!editSessionId || !activeSession) return;
    const key = parseAnswerKey(answerKeyText);
    saveSession(editSessionId, sessionName.trim() || activeSession.name, activeSession.config, key);
    refreshSessions();
    setActiveSession(getSession(editSessionId));
    setView('sessionDetail');
    setSnackbarVisible(true);
    setErrorMessage('Session updated successfully!');
  };

  // ── Render: Camera overlay ────────────────────────────────────────────────
  if (view === 'camera') {
    return (
      <CameraScanner
        onCapture={handleCapture}
        onCancel={() => setView(activeSession ? 'sessionDetail' : 'home')}
      />
    );
  }

  // ── Render: New Session setup ─────────────────────────────────────────────
  if (view === 'newSession') {
    return (
      <ScrollView contentContainerStyle={styles.scrollContainer}>
        <View style={styles.header}>
          <Text variant="headlineMedium" style={{ fontWeight: '800' }}>New Marking Session</Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.outline, marginTop: 4 }}>
            Scan your blank template sheet first so the app can auto-detect the bubble grid.
          </Text>
        </View>

        <Surface style={styles.formCard} elevation={1}>
          <Text variant="titleMedium" style={styles.formLabel}>Session Name</Text>
          <TextInput
            mode="outlined"
            placeholder="e.g. Biology Test – Class 10A"
            value={sessionName}
            onChangeText={setSessionName}
            style={styles.input}
            disabled={loading}
          />

          <Text variant="titleMedium" style={[styles.formLabel, { marginTop: 20 }]}>
            Options per Question
          </Text>
          <SegmentedButtons
            value={bubblesPerQ}
            onValueChange={setBubblesPerQ}
            buttons={[
              { value: '4', label: '4 (A–D)', disabled: loading },
              { value: '5', label: '5 (A–E)', disabled: loading },
            ]}
            style={{ marginTop: 8 }}
          />

          <Text variant="titleMedium" style={[styles.formLabel, { marginTop: 20 }]}>
            Answer Key  <Text variant="bodySmall" style={{ color: theme.colors.outline }}>(optional — comma separated)</Text>
          </Text>
          <TextInput
            mode="outlined"
            placeholder="A, B, C, D, A, …"
            value={answerKeyText}
            onChangeText={setAnswerKeyText}
            style={styles.input}
            autoCapitalize="characters"
            disabled={loading}
          />
          {answerKeyText.length > 0 && (
            <Text variant="bodySmall" style={{ color: theme.colors.primary, marginTop: 4 }}>
              {parseAnswerKey(answerKeyText).length} answer(s) entered
            </Text>
          )}
        </Surface>

        <View style={styles.actionRow}>
          <Button 
            mode="outlined" 
            onPress={() => {
              if (loading) {
                isCancelledRef.current = true;
                setLoading(false);
                setProgressText('');
              }
              setView('home');
            }} 
            style={{ flex: 1, marginRight: 8 }}
          >
            Cancel
          </Button>
          <Button
            mode="contained"
            icon="camera"
            style={{ flex: 2 }}
            loading={loading}
            disabled={loading}
            onPress={() => {
              setCameraMode('learn');
              setView('camera');
            }}
          >
            {loading && progressText ? progressText.toUpperCase() : 'Scan Template'}
          </Button>
        </View>
      </ScrollView>
    );
  }

  // ── Render: Session Detail (scan subsequent sheets) ───────────────────────
  if (view === 'sessionDetail' && activeSession) {
    const cfg: GridConfig = activeSession.config;
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <ScrollView contentContainerStyle={styles.scrollContainer}>
          <View style={styles.header}>
            <Button
              icon="arrow-left"
              mode="text"
              onPress={() => { setActiveSession(null); setView('sessions'); }}
              style={{ alignSelf: 'flex-start', marginLeft: -8 }}
            >
              Sessions
            </Button>
            <Text variant="headlineSmall" style={{ fontWeight: '800', marginTop: 8 }}>
              {activeSession.name}
            </Text>
            <View style={styles.chipRow}>
              <Chip icon="table-large" compact>{cfg.totalQuestions} Questions</Chip>
              <Chip icon="alpha-a-circle" compact style={{ marginLeft: 8 }}>
                {cfg.bubblesPerQuestion} Options
              </Chip>
              {activeSession.answerKey?.length > 0 && (
                <Chip icon="key" compact style={{ marginLeft: 8 }}>Key Loaded</Chip>
              )}
            </View>
            <View style={{ marginTop: 8, flexDirection: 'row', justifyContent: 'flex-end' }}>
                <Button 
                    icon="pencil" 
                    mode="text" 
                    compact
                    onPress={() => {
                        setSessionName(activeSession.name);
                        setAnswerKeyText(activeSession.answerKey?.join(', ') || '');
                        setEditSessionId(activeSession.id);
                        setView('editSession');
                    }}
                >
                    Edit Session Key
                </Button>
            </View>
          </View>

          <Surface style={styles.heroSurface} elevation={2}>
            <View style={styles.heroContent}>
              <Avatar.Icon size={64} icon="barcode-scan" style={{ backgroundColor: theme.colors.primaryContainer, marginBottom: 16 }} color={theme.colors.onPrimaryContainer} />
              <Text variant="titleLarge" style={{ fontWeight: 'bold', textAlign: 'center', marginBottom: 8 }}>
                Scan a Student Sheet
              </Text>
              <Text variant="bodyMedium" style={{ textAlign: 'center', color: theme.colors.onSurfaceVariant, marginBottom: 24 }}>
                The grid has been learned. Point the camera at a completed answer sheet and capture.
              </Text>
              <Button
                mode="contained"
                icon="camera"
                loading={loading}
                disabled={loading}
                contentStyle={styles.mainButtonContent}
                labelStyle={styles.mainButtonLabel}
                style={styles.mainButton}
                onPress={() => { setCameraMode('mark'); setView('camera'); }}
              >
                {loading && progressText ? progressText.toUpperCase() : 'SCAN SHEET'}
              </Button>
            </View>
          </Surface>

          {sessionResults.length > 0 && (
            <>
              <View style={[styles.sectionHeader, { marginTop: 32 }]}>
                <Text variant="titleLarge" style={{ fontWeight: '600' }}>
                  Scanned Sheets  ({sessionResults.length})
                </Text>
              </View>
              {sessionResults.map((r: any, i: number) => (
                <Card key={r.id} style={styles.devCard} mode="elevated" elevation={1}>
                  <Card.Title
                    title={`Sheet #${sessionResults.length - i}`}
                    subtitle={`Score: ${r.score} / ${r.totalQ}  •  ${new Date(r.date).toLocaleTimeString()}`}
                    left={props => (
                      <Avatar.Text
                        {...props}
                        label={`${Math.round((r.score / r.totalQ) * 100)}%`}
                        size={44}
                        style={{ backgroundColor: theme.colors.secondaryContainer }}
                      />
                    )}
                  />
                </Card>
              ))}
            </>
          )}
        </ScrollView>

        {/* Result Dialog */}
        <Portal>
          <Dialog visible={showResult} onDismiss={() => setShowResult(false)} style={styles.dialog}>
            <View style={styles.dialogHeader}>
              <View style={[styles.scoreBubble, { backgroundColor: theme.colors.primaryContainer }]}>
                <Text variant="displaySmall" style={{ color: theme.colors.onPrimaryContainer, fontWeight: 'bold' }}>
                  {lastScore !== null ? lastScore : '—'}
                </Text>
                <Text variant="labelSmall" style={{ color: theme.colors.onPrimaryContainer }}>
                  {lastScore !== null ? `/ ${activeSession.config.totalQuestions}` : 'NO KEY'}
                </Text>
              </View>
              <Text variant="headlineSmall" style={{ fontWeight: 'bold', marginTop: 16 }}>Sheet Graded</Text>
              
              <View style={[styles.chipRow, { justifyContent: 'center', marginTop: 12 }]}>
                <Chip icon="check-circle" compact textStyle={{ color: theme.colors.primary }}>{lastStats.correct} Correct</Chip>
                <Chip icon="close-circle" compact textStyle={{ color: theme.colors.error }}>{lastStats.incorrect} Wrong</Chip>
                <Chip icon="minus-circle" compact>{lastStats.skipped} Skipped</Chip>
              </View>
            </View>

            <Dialog.ScrollArea style={styles.dialogScrollArea}>
              <ScrollView contentContainerStyle={{ paddingVertical: 10 }}>
                {Object.entries(lastResult).map(([qNum, ans]) => {
                  const correct = activeSession.answerKey?.[parseInt(qNum, 10) - 1];
                  const isRight = correct && ans === correct;
                  const isWrong = correct && ans && ans !== correct;

                  return (
                    <List.Item
                      key={qNum}
                      title={`Q${qNum}`}
                      description={ans || 'Unmarked'}
                      left={props => (
                        <List.Icon
                          {...props}
                          icon={!ans ? 'circle-outline' : isRight ? 'check-circle' : isWrong ? 'close-circle' : 'circle'}
                          color={!ans ? theme.colors.outline : isRight ? theme.colors.primary : isWrong ? theme.colors.error : theme.colors.secondary}
                        />
                      )}
                      right={props => correct ? (
                        <Text {...props} style={{ alignSelf: 'center', color: theme.colors.outline }}>
                          Ans: {correct}
                        </Text>
                      ) : undefined}
                    />
                  );
                })}
              </ScrollView>
            </Dialog.ScrollArea>

            <Dialog.Actions style={styles.dialogActions}>
              <Button mode="contained" onPress={() => setShowResult(false)} style={{ width: '100%' }}>
                CLOSE & CONTINUE
              </Button>
            </Dialog.Actions>
          </Dialog>
        </Portal>
      </View>
    );
  }

  // ── Render: Edit Session ──────────────────────────────────────────────────
  if (view === 'editSession') {
    return (
      <ScrollView contentContainerStyle={styles.scrollContainer}>
        <View style={styles.header}>
          <Text variant="headlineMedium" style={{ fontWeight: '800' }}>Edit Session</Text>
        </View>

        <Surface style={styles.formCard} elevation={1}>
          <Text variant="titleMedium" style={styles.formLabel}>Session Name</Text>
          <TextInput
            mode="outlined"
            placeholder="e.g. Biology Test"
            value={sessionName}
            onChangeText={setSessionName}
            style={styles.input}
          />

          <Text variant="titleMedium" style={[styles.formLabel, { marginTop: 20 }]}>
            Answer Key <Text variant="bodySmall" style={{ color: theme.colors.outline }}>(comma separated)</Text>
          </Text>
          <TextInput
            mode="outlined"
            placeholder="A, B, C, D..."
            value={answerKeyText}
            onChangeText={setAnswerKeyText}
            style={styles.input}
            autoCapitalize="characters"
          />
        </Surface>

        <View style={styles.actionRow}>
          <Button mode="outlined" onPress={() => setView('sessionDetail')} style={{ flex: 1, marginRight: 8 }}>
            Cancel
          </Button>
          <Button
            mode="contained"
            icon="check"
            style={{ flex: 2 }}
            onPress={handleUpdateSession}
          >
            Save Changes
          </Button>
        </View>
      </ScrollView>
    );
  }

  // ── Render: Sessions list ─────────────────────────────────────────────────
  if (view === 'sessions') {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <ScrollView contentContainerStyle={styles.scrollContainer}>
          <View style={styles.header}>
            <Button icon="arrow-left" mode="text" onPress={() => setView('home')} style={{ alignSelf: 'flex-start', marginLeft: -8 }}>
              Home
            </Button>
            <Text variant="headlineMedium" style={{ fontWeight: '800', marginTop: 8 }}>Marking Sessions</Text>
          </View>

          {sessions.length === 0 ? (
            <Surface style={[styles.formCard, { alignItems: 'center', paddingVertical: 40 }]} elevation={1}>
              <Avatar.Icon size={56} icon="folder-open-outline" style={{ backgroundColor: theme.colors.surfaceVariant }} />
              <Text variant="titleMedium" style={{ marginTop: 16, color: theme.colors.outline }}>No sessions yet</Text>
              <Text variant="bodySmall" style={{ color: theme.colors.outline, marginTop: 4 }}>Create a new session to get started</Text>
            </Surface>
          ) : (
            sessions.map(sess => (
              <Card
                key={sess.id}
                style={styles.devCard}
                mode="elevated"
                elevation={1}
                onPress={() => {
                  setActiveSession(getSession(sess.id));
                  setSessionResults(getResultsForSession(sess.id));
                  setView('sessionDetail');
                }}
              >
                <Card.Title
                  title={sess.name}
                  subtitle={`${sess.totalQuestions} Q  •  ${sess.bubblesPerQuestion} options  •  ${new Date(sess.createdAt).toLocaleDateString()}`}
                  left={props => <Avatar.Icon {...props} icon="clipboard-list" size={44} style={{ backgroundColor: theme.colors.secondaryContainer }} />}
                  right={props => (
                    <Button
                      {...props}
                      icon="delete"
                      mode="text"
                      textColor={theme.colors.error}
                      onPress={() =>
                        Alert.alert('Delete Session', 'This will delete all results too.', [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Delete', style: 'destructive', onPress: () => { deleteSession(sess.id); refreshSessions(); } },
                        ])
                      }
                    >
                      {''}
                    </Button>
                  )}
                />
              </Card>
            ))
          )}

          <Button
            mode="contained"
            icon="plus"
            style={styles.secondaryButton}
            contentStyle={{ height: 48 }}
            onPress={() => setView('newSession')}
          >
            NEW SESSION
          </Button>
        </ScrollView>
      </View>
    );
  }

  // ── Render: Home ──────────────────────────────────────────────────────────
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.scrollContainer} showsVerticalScrollIndicator={false}>

        <View style={styles.header}>
          <Text variant="displaySmall" style={[styles.title, { color: theme.colors.primary }]}>OmrVision</Text>
          <Text variant="titleMedium" style={{ color: theme.colors.outline, marginTop: 4 }}>
            Fast · Offline · Auto-detecting
          </Text>
        </View>

        <Surface style={styles.heroSurface} elevation={2}>
          <View style={styles.heroContent}>
            <Avatar.Icon size={72} icon="line-scan" style={{ backgroundColor: theme.colors.primaryContainer, marginBottom: 16 }} color={theme.colors.onPrimaryContainer} />
            <Text variant="headlineSmall" style={{ fontWeight: 'bold', marginBottom: 8, textAlign: 'center' }}>
              No Templates Needed
            </Text>
            <Text variant="bodyMedium" style={{ textAlign: 'center', color: theme.colors.onSurfaceVariant, marginBottom: 24, paddingHorizontal: 10 }}>
              The app auto-detects the bubble grid from your first sheet scan. No manual template setup required.
            </Text>
            <Button
              mode="contained"
              icon="plus-circle"
              onPress={() => setView('newSession')}
              loading={loading}
              disabled={loading}
              contentStyle={styles.mainButtonContent}
              labelStyle={styles.mainButtonLabel}
              style={styles.mainButton}
            >
              NEW SESSION
            </Button>
          </View>
        </Surface>

        <View style={styles.sectionHeader}>
          <Text variant="titleLarge" style={{ fontWeight: '600' }}>Recent Sessions</Text>
        </View>

        {sessions.length === 0 ? (
          <Card style={styles.devCard} mode="elevated" elevation={1}>
            <Card.Content style={{ alignItems: 'center', paddingVertical: 24 }}>
              <Text variant="bodyMedium" style={{ color: theme.colors.outline }}>No sessions yet. Create one to begin.</Text>
            </Card.Content>
          </Card>
        ) : (
          sessions.slice(0, 3).map(sess => (
            <Card
              key={sess.id}
              style={styles.devCard}
              mode="elevated"
              elevation={1}
              onPress={() => {
                setActiveSession(getSession(sess.id));
                setSessionResults(getResultsForSession(sess.id));
                setView('sessionDetail');
              }}
            >
              <Card.Title
                title={sess.name}
                subtitle={`${sess.totalQuestions} questions  •  ${sess.bubblesPerQuestion} options`}
                left={props => <Avatar.Icon {...props} icon="clipboard-check" size={44} style={{ backgroundColor: theme.colors.secondaryContainer }} />}
              />
            </Card>
          ))
        )}

        {sessions.length > 3 && (
          <Button mode="text" onPress={() => setView('sessions')} style={{ marginHorizontal: 20 }}>
            View all {sessions.length} sessions
          </Button>
        )}

      </ScrollView>

      <Snackbar
        visible={snackbarVisible}
        onDismiss={() => setSnackbarVisible(false)}
        duration={4000}
        style={{ backgroundColor: theme.colors.error }}
        action={{ label: 'OK', onPress: () => setSnackbarVisible(false), labelStyle: { color: '#fff' } }}
      >
        <Text style={{ color: '#fff', fontWeight: '500' }}>{errorMessage}</Text>
      </Snackbar>
    </View>
  );
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  scrollContainer: { paddingBottom: 48 },
  header: { paddingTop: 60, paddingHorizontal: 24, paddingBottom: 24 },
  title:  { fontWeight: '900', letterSpacing: -0.5 },
  heroSurface: { marginHorizontal: 20, borderRadius: 24, overflow: 'hidden', backgroundColor: '#1E293B' },
  heroContent: { padding: 30, alignItems: 'center' },
  mainButton:        { borderRadius: 30, width: '100%' },
  mainButtonContent: { height: 60 },
  mainButtonLabel:   { fontSize: 16, fontWeight: 'bold', letterSpacing: 1 },
  sectionHeader: { paddingHorizontal: 24, marginTop: 36, marginBottom: 16 },
  devCard: { marginHorizontal: 20, borderRadius: 16, marginBottom: 12 },
  formCard: { marginHorizontal: 20, borderRadius: 16, padding: 20, marginBottom: 12 },
  formLabel: { fontWeight: '600', marginBottom: 6 },
  input: { marginTop: 4 },
  actionRow: { flexDirection: 'row', marginHorizontal: 20, marginTop: 20 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, gap: 8 },
  secondaryButton: { borderRadius: 24, alignSelf: 'center', width: '60%', marginTop: 20, marginBottom: 10 },
  dialog: { borderRadius: 24, maxHeight: '85%' },
  dialogHeader: { alignItems: 'center', paddingTop: 30, paddingBottom: 20 },
  scoreBubble: {
    width: 120, height: 120, borderRadius: 60,
    alignItems: 'center', justifyContent: 'center',
    elevation: 4,
  },
  dialogScrollArea: { paddingHorizontal: 0, borderColor: 'rgba(255,255,255,0.1)' },
  dialogActions: { padding: 20, justifyContent: 'center' },
});

export default HomeScreen;
