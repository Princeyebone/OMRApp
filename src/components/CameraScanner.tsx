import React, { useRef, useState, useEffect } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, ActivityIndicator, Linking } from 'react-native';
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { useTheme, IconButton, Button } from 'react-native-paper';

interface CameraScannerProps {
  onCapture: (imagePath: string) => void;
  onCancel: () => void;
}

const CameraScanner: React.FC<CameraScannerProps> = ({ onCapture, onCancel }) => {
  const theme = useTheme();
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);
  const [isTakingPhoto, setIsTakingPhoto] = useState(false);
  const [hasPrompted, setHasPrompted] = useState(false);

  useEffect(() => {
    if (!hasPermission && !hasPrompted) {
      (async () => {
        await requestPermission();
        setHasPrompted(true);
      })();
    }
  }, [hasPermission, hasPrompted, requestPermission]);

  if (!hasPermission) {
    if (hasPrompted) {
      return (
        <View style={[styles.container, { backgroundColor: '#000', justifyContent: 'center', padding: 40 }]}>
          <Text style={{ color: '#fff', textAlign: 'center', fontSize: 18, marginBottom: 20 }}>
            Camera permission is permanently denied.
          </Text>
          <Text style={{ color: '#aaa', textAlign: 'center', marginBottom: 40 }}>
            We need camera access to scan your OMR sheets. Please enable it in Android Settings.
          </Text>
          <Button mode="contained" onPress={() => Linking.openSettings()} style={{ marginBottom: 16 }}>
            OPEN SETTINGS
          </Button>
          <Button mode="outlined" onPress={onCancel}>
            GO BACK
          </Button>
        </View>
      );
    }
    
    return (
      <View style={[styles.container, { backgroundColor: '#000', justifyContent: 'center' }]}>
        <ActivityIndicator size="large" color="#fff" />
        <Text style={{ color: '#fff', textAlign: 'center', marginTop: 20 }}>Requesting camera permission...</Text>
      </View>
    );
  }

  if (device == null) {
    return (
      <View style={[styles.container, { backgroundColor: '#000', justifyContent: 'center' }]}>
        <Text style={{ color: '#fff', textAlign: 'center' }}>No Camera Device Found</Text>
        <TouchableOpacity onPress={onCancel} style={{ marginTop: 20 }}>
          <Text style={{ color: theme.colors.primary }}>GO BACK</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const takePhoto = async () => {
    if (cameraRef.current && !isTakingPhoto) {
      setIsTakingPhoto(true);
      try {
        const photo = await cameraRef.current.takePhoto({
          flash: 'off',
        });
        
        let path = photo.path;
        if (!path.startsWith('file://')) {
          path = `file://${path}`;
        }
        onCapture(path);
      } catch (err) {
        console.error("Camera capture failed", err);
        setIsTakingPhoto(false);
      }
    }
  };

  return (
    <View style={styles.container}>
      <Camera
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
      />
      
      {/* Overlay Mask */}
      <View style={styles.overlay}>
        <View style={styles.maskHeader}>
          <Text style={styles.instructionText}>Align the sheet within the corners</Text>
        </View>
        <View style={styles.maskCenter}>
          <View style={styles.maskSide} />
          <View style={styles.focusFrame}>
            {/* Corner Markers */}
            <View style={[styles.corner, styles.topLeft]} />
            <View style={[styles.corner, styles.topRight]} />
            <View style={[styles.corner, styles.bottomLeft]} />
            <View style={[styles.corner, styles.bottomRight]} />
            
            {/* Center Crosshair Optional */}
            <View style={styles.crosshairX} />
            <View style={styles.crosshairY} />
          </View>
          <View style={styles.maskSide} />
        </View>
        <View style={styles.maskFooter}>
          <IconButton
            icon="close"
            iconColor="#fff"
            size={32}
            style={styles.closeButton}
            onPress={onCancel}
          />
          <TouchableOpacity 
            style={[styles.captureButton, isTakingPhoto && { opacity: 0.5 }]} 
            onPress={takePhoto}
            disabled={isTakingPhoto}
          >
            <View style={styles.captureInner} />
          </TouchableOpacity>
          <View style={styles.footerSpacer} />
        </View>
      </View>
    </View>
  );
};

const maskColor = 'rgba(0, 0, 0, 0.65)';
const frameBorderColor = '#3B82F6';

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 999,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
  },
  maskHeader: {
    flex: 1,
    backgroundColor: maskColor,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 20,
  },
  instructionText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    overflow: 'hidden',
  },
  maskCenter: {
    flexDirection: 'row',
    height: '65%', // The height of the focal area
  },
  maskSide: {
    flex: 1,
    backgroundColor: maskColor,
  },
  focusFrame: {
    width: '85%', 
    height: '100%',
    backgroundColor: 'transparent',
    position: 'relative',
  },
  maskFooter: {
    flex: 1,
    backgroundColor: maskColor,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 30,
  },
  corner: {
    position: 'absolute',
    width: 40,
    height: 40,
    borderColor: frameBorderColor,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
  },
  crosshairX: {
    position: 'absolute',
    top: '50%',
    left: '45%',
    right: '45%',
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
  },
  crosshairY: {
    position: 'absolute',
    left: '50%',
    top: '45%',
    bottom: '45%',
    width: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
  },
  closeButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  captureButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 4,
    borderColor: '#fff',
  },
  captureInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#fff',
  },
  footerSpacer: {
    width: 64, // roughly matches the close button size for alignment
  }
});

export default CameraScanner;
