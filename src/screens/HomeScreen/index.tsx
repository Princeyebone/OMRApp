import React, { useState, useEffect } from 'react';
import { StyleSheet, View, ScrollView, ImageBackground, BackHandler } from 'react-native';
import { Text, Card, Button, Avatar, useTheme, Dialog, Portal, List, Surface, Snackbar } from 'react-native-paper';
import RNFS from 'react-native-fs';
import { OMRProcessor } from '../../algorithm/omrProcessor';
import { saveResult } from '../../db/database';
import CameraScanner from '../../components/CameraScanner';
import { bundledTemplate, bundledEvaluation } from '../../algorithm/bundledAssets';

const HomeScreen = () => {
  const theme = useTheme();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [scoreVal, setScoreVal] = useState<number>(0);
  const [showResult, setShowResult] = useState(false);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [snackbarVisible, setSnackbarVisible] = useState(false);
  const [progressText, setProgressText] = useState("");

  const showError = (msg: string) => {
    setErrorMessage(msg);
    setSnackbarVisible(true);
  };

  useEffect(() => {
    const onBackPress = () => {
      if (isCameraActive) {
        setIsCameraActive(false);
        return true;
      }
      return false;
    };
    
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
    return () => subscription.remove();
  }, [isCameraActive]);

  const processAndScore = async (imagePath: string, testName: string) => {
    setLoading(true);
    try {
      const template = bundledTemplate;
      const evaluation = bundledEvaluation;
      const markerPath = "BUNDLED";

      console.log(`Starting OMR processing for ${testName}...`);
      const startTime = Date.now();
      const data = await OMRProcessor.processImage(imagePath, template, markerPath, (msg) => {
        setProgressText(msg);
      });
      const duration = Date.now() - startTime;
      console.log(`OMR finished in ${duration}ms`);

      let score = 0;
      if (evaluation && evaluation.options) {
          const correctAnswers = evaluation.options.answers_in_order;
          for (let i = 1; i <= 20; i++) {
              const label = `q${i}`;
              if (data[label] === correctAnswers[i-1]) {
                  score += 4;
              } else if (data[label] && data[label] !== '') {
                  score -= 1;
              }
          }
      }

      const studentId = data.Roll || "Unknown";
      saveResult(studentId, data, score);
      
      setScoreVal(score);
      setResult(data);
      setShowResult(true);
    } catch (error: any) {
      console.log("[OMR Error]:", error);
      let userMessage = "An unexpected error occurred. Please try again.";
      if (error.message.includes('markers')) {
         userMessage = "Could not find the page markers. Please align the sheet clearly within the frame.";
      } else if (error.message.includes('Template')) {
         userMessage = "Template configuration is missing. Sync assets first.";
      }
      showError(userMessage);
    } finally {
      setLoading(false);
      setProgressText("");
    }
  };

  const runBundledTest = async () => {
    const defaultImagePath = `${RNFS.ExternalDirectoryPath}/sample1/sheet_image.jpg`;
    await processAndScore(defaultImagePath, "Sample Data");
  };

  const runCameraScan = () => {
    setIsCameraActive(true);
  };

  const handleCameraCapture = async (photoUri: string) => {
    setIsCameraActive(false);
    await processAndScore(photoUri.replace('file://', ''), "Camera Capture");
  };

  if (isCameraActive) {
    return (
      <CameraScanner 
        onCapture={handleCameraCapture} 
        onCancel={() => setIsCameraActive(false)} 
      />
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.scrollContainer} showsVerticalScrollIndicator={false}>
        
        <View style={styles.header}>
          <Text variant="displaySmall" style={[styles.title, { color: theme.colors.primary }]}>OmrVision</Text>
          <Text variant="titleMedium" style={{ color: theme.colors.outline, marginTop: 4 }}>Fast, Offline Precision Grading</Text>
        </View>

        <Surface style={styles.heroSurface} elevation={2}>
          <View style={styles.heroContent}>
            <Avatar.Icon size={72} icon="line-scan" style={{ backgroundColor: theme.colors.primaryContainer, marginBottom: 16 }} color={theme.colors.onPrimaryContainer} />
            <Text variant="headlineSmall" style={{ fontWeight: 'bold', marginBottom: 8, textAlign: 'center' }}>Capture a Sheet</Text>
            <Text variant="bodyMedium" style={{ textAlign: 'center', color: theme.colors.onSurfaceVariant, marginBottom: 24, paddingHorizontal: 10 }}>
              Align the four corner markers perfectly inside the frame to instantly grade multiple choice assessments using your camera.
            </Text>
            <Button 
              mode="contained" 
              icon="camera" 
              onPress={runCameraScan} 
              loading={loading}
              disabled={loading}
              contentStyle={styles.mainButtonContent}
              labelStyle={styles.mainButtonLabel}
              style={styles.mainButton}
            >
              {loading && progressText ? progressText.toUpperCase() : "SCAN NOW"}
            </Button>
          </View>
        </Surface>

        <View style={styles.sectionHeader}>
          <Text variant="titleLarge" style={{ fontWeight: '600' }}>Developer Tools</Text>
        </View>

        <Card style={styles.devCard} mode="elevated" elevation={1}>
          <Card.Title 
            title="Run Bundled Benchmark" 
            subtitle="Test matching pipeline on sample data"
            left={(props) => <Avatar.Icon {...props} icon="code-braces" size={44} style={{ backgroundColor: theme.colors.secondaryContainer }} />}
          />
          <Card.Actions>
            <Button mode="outlined" onPress={runBundledTest} loading={loading} disabled={loading} icon="play">
              {loading && progressText ? progressText.toUpperCase() : "RUN BENCHMARK"}
            </Button>
          </Card.Actions>
        </Card>

      </ScrollView>

      <Portal>
        <Dialog visible={showResult} onDismiss={() => setShowResult(false)} style={styles.dialog}>
          <View style={styles.dialogHeader}>
            <View style={[styles.scoreBubble, { backgroundColor: theme.colors.primaryContainer }]}>
               <Text variant="displaySmall" style={{ color: theme.colors.onPrimaryContainer, fontWeight: 'bold' }}>{scoreVal}</Text>
               <Text variant="labelSmall" style={{ color: theme.colors.onPrimaryContainer }}>SCORE</Text>
            </View>
            <Text variant="headlineSmall" style={{ fontWeight: 'bold', marginTop: 16 }}>Test Graded</Text>
            <Text variant="bodyMedium" style={{ color: theme.colors.outline, marginTop: 4 }}>Student: {result?.Roll}</Text>
          </View>
          
          <Dialog.ScrollArea style={styles.dialogScrollArea}>
            <ScrollView contentContainerStyle={{ paddingVertical: 10 }}>
              {result && Object.keys(result)
                .filter(key => key !== 'Roll')
                .map((key) => {
                  const val = result[key];
                  const isEmpty = val === "";
                  return (
                    <List.Item
                      key={key}
                      title={`Question ${key.toUpperCase()}`}
                      description={isEmpty ? 'Unmarked' : `Bubbled: ${val}`}
                      left={props => <List.Icon {...props} icon={isEmpty ? "circle-outline" : "check-circle"} color={isEmpty ? theme.colors.outline : theme.colors.primary} />}
                    />
                  );
                })}
            </ScrollView>
          </Dialog.ScrollArea>
          
          <Dialog.Actions style={styles.dialogActions}>
            <Button mode="contained" onPress={() => setShowResult(false)} style={{ width: '100%' }}>CLOSE & CONTINUE</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar
        visible={snackbarVisible}
        onDismiss={() => setSnackbarVisible(false)}
        duration={4000}
        style={{ backgroundColor: theme.colors.error }}
        action={{
          label: 'OK',
          onPress: () => setSnackbarVisible(false),
          labelStyle: { color: '#ffffff' }
        }}
      >
        <Text style={{ color: '#ffffff', fontWeight: '500' }}>{errorMessage}</Text>
      </Snackbar>
    </View>
  );
};

const styles = StyleSheet.create({
  scrollContainer: {
    paddingBottom: 40,
  },
  header: {
    paddingTop: 70,
    paddingHorizontal: 24,
    paddingBottom: 30,
  },
  title: {
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  heroSurface: {
    marginHorizontal: 20,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#1E293B',
  },
  heroContent: {
    padding: 30,
    alignItems: 'center',
  },
  mainButton: {
    borderRadius: 30,
    width: '100%',
  },
  mainButtonContent: {
    height: 60,
  },
  mainButtonLabel: {
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  sectionHeader: {
    paddingHorizontal: 24,
    marginTop: 40,
    marginBottom: 16,
  },
  devCard: {
    marginHorizontal: 20,
    borderRadius: 16,
    marginBottom: 12,
  },
  dialog: {
    borderRadius: 24,
    maxHeight: '85%',
  },
  dialogHeader: {
    alignItems: 'center',
    paddingTop: 30,
    paddingBottom: 20,
  },
  scoreBubble: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
  },
  dialogScrollArea: {
    paddingHorizontal: 0,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  dialogActions: {
    padding: 20,
    justifyContent: 'center',
  }
});

export default HomeScreen;
