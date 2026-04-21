import React, { useState, useCallback } from 'react';
import { launchImageLibrary } from 'react-native-image-picker';
import {
  StyleSheet,
  View,
  ScrollView,
  BackHandler,
  Image,
} from 'react-native';
import {
  Text,
  Button,
  useTheme,
  Surface,
  Snackbar,
} from 'react-native-paper';
import DocumentScanner from 'react-native-document-scanner-plugin';
import { OMRProcessor } from '../../algorithm/omrProcessor';

type AppView = 'home';

const HomeScreen = () => {
  const theme = useTheme();

  const [view, setView] = useState<AppView>('home');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [snackbarVisible, setSnackbarVisible] = useState(false);
  const [resultBinary, setResultBinary] = useState<string | null>(null);
  const [resultOutlined, setResultOutlined] = useState<string | null>(null);
  const [resultCropped, setResultCropped] = useState<string | null>(null);
  const [resultMajorBoxes, setResultMajorBoxes] = useState<string | null>(null);
  const [resultScored, setResultScored] = useState<string | null>(null);
  const [resultSubColumns, setResultSubColumns] = useState<string | null>(null);
  const [resultRows, setResultRows] = useState<string | null>(null);
  const [resultFinal, setResultFinal] = useState<string | null>(null);

  const showError = (msg: string) => { setErrorMessage(msg); setSnackbarVisible(true); };

  const handleCapture = useCallback(async (photoUri: string) => {
    setLoading(true);
    setResultBinary(null);
    setResultOutlined(null);
    setResultCropped(null);
    setResultMajorBoxes(null);
    setResultScored(null);
    setResultSubColumns(null);
    setResultRows(null);
    setResultFinal(null);
    const cleanPath = photoUri.replace('file://', '');

    try {
      const processed = await OMRProcessor.processImage(cleanPath);
      setResultBinary(processed.binary);
      setResultOutlined(processed.outlined);
      setResultCropped(processed.cropped);
      setResultMajorBoxes(processed.majorBoxes);
      setResultScored(processed.scored);
      setResultSubColumns(processed.subColumns);
      setResultRows(processed.rows);
      setResultFinal(processed.finalScored);
    } catch (err: any) {
      console.error('[OMR ERROR LOG]', err);
      showError('Analysis failed. Please ensure the sheet is well-lit, flat, and the alignment marks are visible.');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleScan = async () => {
    try {
      const { scannedImages } = await DocumentScanner.scanDocument({
        maxNumDocuments: 1,
        croppedImageQuality: 100,
        responseType: 'imageFilePath' as any,
      });

      if (scannedImages && scannedImages.length > 0) {
        handleCapture(scannedImages[0]);
      }
    } catch (err: any) {
      console.error('[Scanner Error]', err);
      showError('Failed to open the document scanner.');
    }
  };

  const handleUpload = async () => {
    const result = await launchImageLibrary({ 
      mediaType: 'photo', 
      quality: 1,
      selectionLimit: 1,
      includeExtra: true,
    });
    
    if (result.assets && result.assets[0].uri) {
      handleCapture(result.assets[0].uri);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <ScrollView contentContainerStyle={styles.scrollContainer} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text variant="displaySmall" style={[styles.title, { color: theme.colors.primary }]}>OMR V2</Text>
          <Text variant="titleMedium" style={{ color: theme.colors.outline, marginTop: 4 }}>
            Native Document Scanner Integration
          </Text>
        </View>

        <Surface style={styles.heroSurface} elevation={2}>
          <View style={styles.heroContent}>
            <Text variant="headlineSmall" style={{ fontWeight: 'bold', marginBottom: 16, textAlign: 'center' }}>
              Load & Process Image
            </Text>
            
            <Button
              mode="contained"
              icon="camera"
              onPress={handleScan}
              loading={loading}
              disabled={loading}
              style={styles.mainButton}
              contentStyle={styles.mainButtonContent}
              labelStyle={styles.mainButtonLabel}
            >
              SCAN SHEET
            </Button>

            <Button
              mode="text"
              icon="image-plus"
              onPress={handleUpload}
              disabled={loading}
              style={{ marginTop: 12 }}
            >
              UPLOAD IMAGE
            </Button>
          </View>
        </Surface>

        {loading && (
           <Text style={{ textAlign: 'center', marginTop: 20 }}>Processing image... (grayscale + adaptive threshold)</Text>
        )}

        {resultBinary && (
          <View style={styles.resultContainer}>
            <Text variant="titleMedium" style={{ fontWeight: 'bold', marginBottom: 8 }}>STEP 1: Original Gray/Binary view</Text>
            <Image 
               source={{ uri: resultBinary }} 
               style={{ width: '100%', height: 350, borderRadius: 12, resizeMode: 'contain', backgroundColor: '#000' }} 
            />
          </View>
        )}

        {resultOutlined && (
          <View style={styles.resultContainer}>
            <Text variant="titleMedium" style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 12 }}>STEP 2: Extracted Contours & Tracks</Text>
            <Image 
               source={{ uri: resultOutlined }} 
               style={{ width: '100%', height: 350, borderRadius: 12, resizeMode: 'contain', backgroundColor: '#000' }} 
            />
          </View>
        )}

        {resultCropped && (
          <View style={styles.resultContainer}>
            <Text variant="titleMedium" style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 12 }}>STEP 3: Isolated Answer Columns</Text>
            <Image 
               source={{ uri: resultCropped }} 
               style={{ width: '100%', height: 350, borderRadius: 12, resizeMode: 'contain', backgroundColor: '#000' }} 
            />
          </View>
        )}

        {resultMajorBoxes && (
          <View style={styles.resultContainer}>
            <Text variant="titleMedium" style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 12, color: 'magenta' }}>STEP 4: Semantic Macro Blocks (Clustering)</Text>
            <Image 
               source={{ uri: resultMajorBoxes }} 
               style={{ width: '100%', height: 350, borderRadius: 12, resizeMode: 'contain', backgroundColor: '#eef' }} 
            />
          </View>
        )}

        {resultScored && (
          <View style={styles.resultContainer}>
            <Text variant="titleMedium" style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 12, color: 'blue' }}>STEP 5: Main Columns</Text>
            <Image 
               source={{ uri: resultScored }} 
               style={{ width: '100%', height: 350, borderRadius: 12, resizeMode: 'contain', backgroundColor: '#eef' }} 
            />
          </View>
        )}

        {resultSubColumns && (
          <View style={styles.resultContainer}>
            <Text variant="titleMedium" style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 12, color: '#ff00ff' }}>STEP 6: Inner Sub-Columns (Q, A, B, C, D)</Text>
            <Image 
               source={{ uri: resultSubColumns }} 
               style={{ width: '100%', height: 350, borderRadius: 12, resizeMode: 'contain', backgroundColor: '#eef' }} 
            />
          </View>
        )}

        {resultRows && (
          <View style={styles.resultContainer}>
            <Text variant="titleMedium" style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 12, color: '#FF8C00' }}>STEP 7: Extracted Rows</Text>
            <Image 
               source={{ uri: resultRows }} 
               style={{ width: '100%', height: 350, borderRadius: 12, resizeMode: 'contain', backgroundColor: '#eef' }} 
            />
          </View>
        )}

        {resultFinal && (
          <View style={styles.resultContainer}>
            <Text variant="titleMedium" style={{ fontWeight: 'bold', marginBottom: 8, marginTop: 12, color: 'red' }}>STEP 8: Scored Readout!</Text>
            <Image 
               source={{ uri: resultFinal }} 
               style={{ width: '100%', height: 350, borderRadius: 12, resizeMode: 'contain', backgroundColor: '#eef' }} 
            />
          </View>
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

const styles = StyleSheet.create({
  scrollContainer: { paddingBottom: 48 },
  header: { paddingTop: 60, paddingHorizontal: 24, paddingBottom: 24 },
  title:  { fontWeight: '900', letterSpacing: -0.5 },
  heroSurface: { marginHorizontal: 20, borderRadius: 24, overflow: 'hidden', backgroundColor: '#1E293B' },
  heroContent: { padding: 30, alignItems: 'center' },
  mainButton:        { borderRadius: 30, width: '100%' },
  mainButtonContent: { height: 60 },
  mainButtonLabel:   { fontSize: 16, fontWeight: 'bold', letterSpacing: 1 },
  resultContainer: { marginHorizontal: 20, marginTop: 30 },
});

export default HomeScreen;
