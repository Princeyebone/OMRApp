import React, { useState } from 'react';
import { StyleSheet, View, ScrollView, Alert } from 'react-native';
import { Text, Card, Button, Avatar, useTheme, Dialog, Portal, List } from 'react-native-paper';
import RNFS from 'react-native-fs';
import { OMRProcessor } from '../../algorithm/omrProcessor';
import { saveResult } from '../../db/database';

const HomeScreen = () => {
  const theme = useTheme();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [showResult, setShowResult] = useState(false);

  const runTest = async () => {
    setLoading(true);
    try {
      const baseDir = `${RNFS.ExternalDirectoryPath}/sample1`;
      const imagePath = `${baseDir}/sheet_image.jpg`;
      const markerPath = `${baseDir}/omr_marker.jpg`;
      const templatePath = `${baseDir}/template.json`;

      // Check if files exist
      const exists = await RNFS.exists(imagePath);
      if (!exists) {
        throw new Error(`Test image not found at ${imagePath}. Please ensure files are pushed to the device.`);
      }

      const templateStr = await RNFS.readFile(templatePath, 'utf8');
      const template = JSON.parse(templateStr);

      const evalPath = `${baseDir}/evaluation.json`;
      let evaluation: any = null;
      if (await RNFS.exists(evalPath)) {
        const evalStr = await RNFS.readFile(evalPath, 'utf8');
        evaluation = JSON.parse(evalStr);
      }

      console.log("Starting OMR processing...");
      const startTime = Date.now();
      const data = await OMRProcessor.processImage(imagePath, template, markerPath);
      const duration = Date.now() - startTime;
      console.log(`OMR processing finished in ${duration}ms`);
      console.log("OMR Extracted Data:", JSON.stringify(data, null, 2));

      // Simple Scoring logic (if evaluation is present)
      let score = 0;
      if (evaluation && evaluation.options) {
          const correctAnswers = evaluation.options.answers_in_order;
          // Example: q1..20
          for (let i = 1; i <= 20; i++) {
              const label = `q${i}`;
              if (data[label] === correctAnswers[i-1]) {
                  score += 4;
              } else if (data[label] && data[label] !== '') {
                  score -= 1;
              }
          }
      }

      // Save Result to SQLite
      const studentId = data.Roll || "001";
      saveResult(studentId, data, score);
      console.log(`Result saved to database for Student ${studentId} with score ${score}`);

      setResult(data);
      setShowResult(true);
      Alert.alert("Success", `OMR processed! Score: ${score}`);
    } catch (error: any) {
      console.error("Test execution failed:", error);
      Alert.alert("Test Failed", error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <ScrollView style={[styles.container, { backgroundColor: theme.colors.background }]}>
        <View style={styles.header}>
          <Text variant="headlineLarge" style={styles.title}>OMR Offline</Text>
          <Text variant="bodyMedium" style={{ color: theme.colors.outline }}>Precision Scanner & Processor</Text>
        </View>

        <View style={styles.content}>
          <Card style={styles.card} mode="elevated">
            <Card.Title 
              title="Process Sample 1" 
              subtitle="Test with bundled data"
              left={(props) => <Avatar.Icon {...props} icon="folder-check" />}
            />
            <Card.Content>
              <Text variant="bodyMedium">Check the accuracy of the ported algorithm using data from sample1 directory.</Text>
            </Card.Content>
            <Card.Actions>
              <Button 
                mode="contained" 
                onPress={runTest} 
                loading={loading} 
                disabled={loading}
              >
                RUN TEST
              </Button>
            </Card.Actions>
          </Card>

          <Card style={styles.card} mode="elevated">
            <Card.Title 
              title="Scan New Sheet" 
              subtitle="Offline Processing"
              left={(props) => <Avatar.Icon {...props} icon="camera" />}
            />
            <Card.Content>
              <Text variant="bodyMedium">Take a photo of a new OMR sheet to process it in real-time without internet.</Text>
            </Card.Content>
            <Card.Actions>
              <Button mode="outlined" onPress={() => console.log("Camera pressed")}>OPEN CAMERA</Button>
            </Card.Actions>
          </Card>

          <Card style={styles.card} mode="elevated">
            <Card.Title 
              title="Scan History" 
              subtitle="Stored in SQLite"
              left={(props) => <Avatar.Icon {...props} icon="history" />}
            />
            <Card.Content>
              <Text variant="bodyMedium">View previously processed sheets, scores, and exports.</Text>
            </Card.Content>
            <Card.Actions>
              <Button onPress={() => console.log("History pressed")}>VIEW ALL</Button>
            </Card.Actions>
          </Card>
        </View>
      </ScrollView>

      <Portal>
        <Dialog visible={showResult} onDismiss={() => setShowResult(false)} style={{ maxHeight: '80%' }}>
          <Dialog.Title>Test Result</Dialog.Title>
          <Dialog.ScrollArea>
            <ScrollView contentContainerStyle={{ paddingVertical: 10 }}>
              {result && Object.entries(result).map(([key, value]: any) => (
                <List.Item
                  key={key}
                  title={key}
                  description={`Detected: ${value}`}
                  left={props => <List.Icon {...props} icon="check-circle-outline" />}
                />
              ))}
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setShowResult(false)}>CLOSE</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    padding: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  content: {
    padding: 20,
  },
  card: {
    marginBottom: 20,
    borderRadius: 15,
  },
});

export default HomeScreen;
