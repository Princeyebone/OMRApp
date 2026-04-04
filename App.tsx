import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Provider as PaperProvider, MD3DarkTheme, MD3LightTheme, useTheme } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { initDatabase } from './src/db/database';
import HomeScreen from './src/screens/HomeScreen';

const App = () => {
  useEffect(() => {
    console.log("App mounting, initializing database...");
    try {
      initDatabase();
      console.log("Database initialized successfully.");
    } catch (error) {
      console.error("Database initialization failed:", error);
    }
  }, []);

  return (
    <SafeAreaProvider>
      <PaperProvider theme={MD3DarkTheme}>
        <View style={styles.container}>
          <HomeScreen />
        </View>
      </PaperProvider>
    </SafeAreaProvider>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;
