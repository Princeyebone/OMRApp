import React, { useState, useEffect } from 'react';
import { StyleSheet, View, ScrollView, RefreshControl, Alert } from 'react-native';
import { Text, Card, Avatar, useTheme, IconButton } from 'react-native-paper';
import { getAllResults, deleteResult } from '../../db/database';

const HistoryScreen = () => {
  const theme = useTheme();
  const [results, setResults] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadHistory = () => {
    try {
      const data = getAllResults();
      setResults(data);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    loadHistory();
    setRefreshing(false);
  }, []);

  const handleDelete = (id: number) => {
    Alert.alert(
      "Delete Record",
      "Are you sure you want to permanently delete this scan result?",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Delete", 
          style: "destructive", 
          onPress: () => {
            deleteResult(id);
            loadHistory();
          } 
        }
      ]
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <Text variant="headlineMedium" style={styles.title}>Scan History</Text>
        <Text variant="bodyMedium" style={{ color: theme.colors.outline, marginTop: 4 }}>
          Pull down to refresh records
        </Text>
      </View>
      
      <ScrollView 
        contentContainerStyle={styles.scrollContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />}
      >
        {results.length === 0 ? (
          <View style={styles.emptyState}>
            <Avatar.Icon size={80} icon="file-document-outline" style={{ backgroundColor: 'transparent' }} color={theme.colors.outline} />
            <Text variant="bodyLarge" style={{ color: theme.colors.outline, marginTop: 16 }}>No scans yet. Process a sheet to see history!</Text>
          </View>
        ) : (
          results.map((item, idx) => {
            const dateStr = new Date(item.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
            return (
              <Card key={idx} style={styles.card} mode="elevated">
                <Card.Title 
                  title={`Student: ${item.student_id}`}
                  subtitle={`Scanned on ${dateStr}`}
                  left={(props) => <Avatar.Icon {...props} icon="account-circle" style={{ backgroundColor: theme.colors.primaryContainer }} color={theme.colors.onPrimaryContainer} />}
                  right={(props) => (
                    <View style={styles.rightOverlay}>
                      <View style={styles.scoreContainer}>
                        <Text variant="titleLarge" style={[styles.scoreText, { color: theme.colors.primary }]}>{item.score}</Text>
                        <Text variant="labelSmall" style={{ color: theme.colors.outline }}>PTS</Text>
                      </View>
                      <IconButton 
                        icon="trash-can-outline" 
                        iconColor={theme.colors.error} 
                        size={24} 
                        onPress={() => handleDelete(item.id)} 
                      />
                    </View>
                  )}
                />
              </Card>
            );
          })
        )}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingTop: 60,
    paddingHorizontal: 24,
    paddingBottom: 20,
  },
  title: {
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 100,
  },
  card: {
    marginBottom: 16,
    borderRadius: 16,
  },
  scoreContainer: {
    alignItems: 'center',
    marginRight: 8,
  },
  rightOverlay: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
  },
  scoreText: {
    fontWeight: 'bold',
  },
  emptyState: {
    marginTop: 80,
    alignItems: 'center',
    justifyContent: 'center',
  }
});

export default HistoryScreen;
