import React, { useEffect, useState } from 'react';
import { StyleSheet, View, LogBox, Text, Animated } from 'react-native';
import { Provider as PaperProvider, MD3DarkTheme, BottomNavigation } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { initDatabase } from './src/db/database';
import HomeScreen from './src/screens/HomeScreen';
import HistoryScreen from './src/screens/HistoryScreen';

const customDarkTheme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: '#3B82F6', 
    onPrimary: '#FFFFFF',
    primaryContainer: '#1E3A8A', 
    onPrimaryContainer: '#DBEAFE',
    background: '#0F172A', 
    onBackground: '#F8FAFC',
    surface: '#1E293B', 
    onSurface: '#F8FAFC',
    surfaceVariant: '#334155', 
    onSurfaceVariant: '#CBD5E1', 
    outline: '#94A3B8', 
    elevation: {
      ...MD3DarkTheme.colors.elevation,
      level1: '#1E293B',
      level2: '#334155',
      level3: '#475569',
      level4: '#64748B',
      level5: '#94A3B8',
    }
  },
};

LogBox.ignoreAllLogs(true); // Completely hides DEV Warning/Error banners from the UI

const AnimatedSkeleton = () => {
  const fadeAnim = React.useRef(new Animated.Value(0.2)).current;
  
  React.useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(fadeAnim, { toValue: 0.7, duration: 600, useNativeDriver: true }),
        Animated.timing(fadeAnim, { toValue: 0.2, duration: 600, useNativeDriver: true })
      ])
    ).start();
  }, [fadeAnim]);

  return <Animated.View style={[styles.skeletonCard, { opacity: fadeAnim }]} />;
};

const App = () => {
  const [index, setIndex] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const [routes] = useState([
    { key: 'scanner', title: 'Scanner', focusedIcon: 'image-search', unfocusedIcon: 'camera-outline' },
    { key: 'history', title: 'History', focusedIcon: 'history' },
  ]);

  const renderScene = BottomNavigation.SceneMap({
    scanner: HomeScreen,
    history: HistoryScreen,
  });

  useEffect(() => {
    try {
      initDatabase();
    } catch (error) {
      console.log("Database init failed:", error);
    }
    
    // Simulate initial heavy bundle load/splash screen
    const timer = setTimeout(() => {
      setIsReady(true);
    }, 1500);

    return () => clearTimeout(timer);
  }, []);

  if (!isReady) {
    return (
      <View style={[styles.splashContainer, { backgroundColor: customDarkTheme.colors.background }]}>
         <View style={styles.splashLogo}>
            <Text style={{ fontSize: 48, fontWeight: '900', color: customDarkTheme.colors.onPrimaryContainer }}>O</Text>
         </View>
         <Text style={{ color: customDarkTheme.colors.primary, fontSize: 32, fontWeight: '900', letterSpacing: 1, marginTop: 24 }}>OmrVision</Text>
         <Text style={{ color: customDarkTheme.colors.outline, fontSize: 16, marginTop: 8 }}>Initializing Engine...</Text>
         {/* Skeleton Loaders mimicking cards */}
         <View style={styles.skeletonContainer}>
           <AnimatedSkeleton />
           <AnimatedSkeleton />
         </View>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <PaperProvider theme={customDarkTheme}>
        <BottomNavigation
          navigationState={{ index, routes }}
          onIndexChange={setIndex}
          renderScene={renderScene}
          barStyle={{ backgroundColor: customDarkTheme.colors.surface, elevation: 8 }}
          activeColor={customDarkTheme.colors.primary}
          inactiveColor={customDarkTheme.colors.outline}
        />
      </PaperProvider>
    </SafeAreaProvider>
  );
};

const styles = StyleSheet.create({
  splashContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashLogo: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#1E3A8A',
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 10,
    shadowColor: '#3B82F6',
    shadowOpacity: 0.5,
    shadowRadius: 15,
  },
  skeletonContainer: {
    width: '100%',
    paddingHorizontal: 30,
    marginTop: 60,
  },
  skeletonCard: {
    height: 120,
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: 16,
    marginBottom: 20,
    opacity: 0.5,
  }
});

export default App;
