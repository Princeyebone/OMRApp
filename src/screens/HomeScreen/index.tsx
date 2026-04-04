import React from 'react';
import { StyleSheet, View, ScrollView, Image } from 'react-native';
import { Text, Card, Button, Avatar, useTheme } from 'react-native-paper';

const HomeScreen = () => {
  const theme = useTheme();

  return (
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
            <Button mode="contained" onPress={() => console.log("RUN TEST pressed")}>RUN TEST</Button>
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
            <Button mode="outlined">OPEN CAMERA</Button>
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
            <Button>VIEW ALL</Button>
          </Card.Actions>
        </Card>
      </View>
    </ScrollView>
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
