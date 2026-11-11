/**
 * userProtectionService.js
 *
 * ユーザー情報保護機能を提供するService
 * - ユーザー登録後の情報ロック（読み取り専用化・編集禁止）
 * - パスキー認証による管理者権限検証
 * - 管理者（野口英光）のみ編集・削除可能
 *
 * 規則：
 * - 登録済みユーザーのすべてのフィールドを保護する
 * - 編集・削除ボタンを非表示にする
 * - 登録済みユーザーは「閲覧も不可」にする（管理者を除く）
 * - パスキー認証を編集時に必須にする
 */

const crypto = require('node:crypto');

class UserProtectionService {
  constructor(config = {}) {
    this.adminEmail = config.adminEmail || 'k.k.hisyoengineer@hisyoengineer.onmicrosoft.com';
    this.passkeyLength = config.passkeyLength || 64;
    this.passkeyHashAlgorithm = 'sha256';
  }

  /**
   * ユーザー登録情報をロック状態にマーク
   * @param {Object} user ユーザーオブジェクト
   * @param {string} passkey パスキー（初回設定用）
   * @returns {Object} ロック状態のユーザーオブジェクト
   */
  lockUserInfo(user, passkey) {
    if (!user || !user.email) {
      throw new Error('有効なユーザー情報が必要です');
    }

    // パスキーをハッシュ化して保存（平文では保存しない）
    const passkeyHash = this._hashPasskey(passkey);

    return {
      ...user,
      isLocked: true,
      lockedAt: new Date().toISOString(),
      passkeyHash,
      // 以下のフィールドは編集不可フラグを立てる
      readonlyFields: [
        'name',          // 氏名
        'email',         // メールアドレス
        'department',    // 部門
        'employeeId',    // 社員ID
        'hireDate',      // 入社日
        'passkey'        // パスキー
      ]
    };
  }

  /**
   * ユーザー情報がロック状態かどうかを確認
   * @param {Object} user ユーザーオブジェクト
   * @returns {boolean} true = ロック済み、false = 未ロック
   */
  isUserLocked(user) {
    return user && user.isLocked === true;
  }

  /**
   * パスキー認証を検証
   * @param {string} passkey 入力されたパスキー
   * @param {Object} user ロック済みユーザーオブジェクト
   * @returns {boolean} true = 認証成功、false = 認証失敗
   */
  validatePasskey(passkey, user) {
    if (!this.isUserLocked(user)) {
      throw new Error('ロック状態のユーザーではありません');
    }

    if (!passkey || typeof passkey !== 'string') {
      return false;
    }

    const providedHash = this._hashPasskey(passkey);
    return crypto.timingSafeEqual(
      Buffer.from(providedHash),
      Buffer.from(user.passkeyHash)
    );
  }

  /**
   * 管理者権限を確認
   * @param {string} userEmail ユーザーメールアドレス
   * @returns {boolean} true = 管理者、false = 非管理者
   */
  isAdmin(userEmail) {
    if (!userEmail || typeof userEmail !== 'string') {
      return false;
    }
    return userEmail.toLowerCase() === this.adminEmail.toLowerCase();
  }

  /**
   * ユーザー情報の閲覧権限を確認
   * @param {Object} targetUser 対象ユーザー
   * @param {string} currentUserEmail 現在のユーザーメール
   * @returns {boolean} true = 閲覧可、false = 閲覧不可
   */
  canViewUserInfo(targetUser, currentUserEmail) {
    // 自分自身の情報は常に閲覧可
    if (targetUser.email === currentUserEmail) {
      return true;
    }

    // 管理者は常に閲覧可
    if (this.isAdmin(currentUserEmail)) {
      return true;
    }

    // ロック済みユーザーの情報は管理者のみ閲覧可
    if (this.isUserLocked(targetUser)) {
      return false;
    }

    // ロック前のユーザー情報は誰でも閲覧可
    return true;
  }

  /**
   * ユーザー情報の編集権限を確認
   * @param {Object} targetUser 対象ユーザー
   * @param {string} currentUserEmail 現在のユーザーメール
   * @param {string} passkey パスキー（ロック済みユーザーの場合）
   * @returns {Object} { canEdit: boolean, reason: string }
   */
  canEditUserInfo(targetUser, currentUserEmail, passkey = null) {
    // 管理者は常に編集可
    if (this.isAdmin(currentUserEmail)) {
      return { canEdit: true, reason: '管理者権限で編集可能' };
    }

    // 自分自身は編集可（ロック前）
    if (targetUser.email === currentUserEmail && !this.isUserLocked(targetUser)) {
      return { canEdit: true, reason: 'ユーザー本人が編集可能' };
    }

    // ロック済みユーザーの編集は管理者のみ（パスキー認証必須）
    if (this.isUserLocked(targetUser)) {
      if (!this.isAdmin(currentUserEmail)) {
        return { canEdit: false, reason: 'ロック済みユーザーは管理者のみ編集可能' };
      }

      // 管理者でもパスキー認証が必須
      if (!passkey || !this.validatePasskey(passkey, targetUser)) {
        return { canEdit: false, reason: 'パスキー認証が必要です' };
      }

      return { canEdit: true, reason: '管理者のパスキー認証で編集可能' };
    }

    return { canEdit: false, reason: '編集権限がありません' };
  }

  /**
   * ユーザー情報の削除権限を確認
   * @param {Object} targetUser 対象ユーザー
   * @param {string} currentUserEmail 現在のユーザーメール
   * @returns {boolean} true = 削除可、false = 削除不可
   */
  canDeleteUserInfo(targetUser, currentUserEmail) {
    // 管理者のみ削除可能
    // ロック済みユーザーは削除不可（データ保全のため）
    if (this.isUserLocked(targetUser)) {
      return false;
    }

    return this.isAdmin(currentUserEmail);
  }

  /**
   * ユーザーの表示フィールドをフィルタ
   * @param {Object} user ユーザーオブジェクト
   * @param {string} currentUserEmail 現在のユーザーメール
   * @returns {Object} フィルタ後のユーザーオブジェクト
   */
  filterUserFieldsForDisplay(user, currentUserEmail) {
    // 自分自身または管理者の場合は全フィールド表示
    if (user.email === currentUserEmail || this.isAdmin(currentUserEmail)) {
      const { passkeyHash, ...safeUser } = user;
      return safeUser; // パスキーハッシュのみ除外
    }

    // ロック済みユーザーの場合、閲覧不可なら空オブジェクトを返す
    if (this.isUserLocked(user)) {
      return null; // 閲覧不可を示すnull
    }

    // 基本情報のみ表示
    const { passkeyHash, readonlyFields, isLocked, lockedAt, ...basicInfo } = user;
    return basicInfo;
  }

  /**
   * Power Apps での UI 制御情報を生成
   * @param {Object} user ユーザーオブジェクト
   * @param {string} currentUserEmail 現在のユーザーメール
   * @returns {Object} { hideEditButton, hideDeleteButton, makeFieldsReadonly, ... }
   */
  generateUIControlState(user, currentUserEmail) {
    const isAdmin = this.isAdmin(currentUserEmail);
    const isOwner = user.email === currentUserEmail;
    const isLocked = this.isUserLocked(user);

    return {
      hideEditButton: isLocked && !isAdmin,           // ロック済み & 管理者でない → 編集ボタン非表示
      hideDeleteButton: isLocked,                     // ロック済み → 削除ボタン常に非表示
      makeFieldsReadonly: isLocked && !isAdmin,       // ロック済み & 管理者でない → フィールド読み取り専用
      showPasskeyPrompt: isLocked && isAdmin,         // ロック済み & 管理者 → パスキープロンプト表示
      canView: this.canViewUserInfo(user, currentUserEmail),  // 閲覧権限
      canEdit: this.canEditUserInfo(user, currentUserEmail).canEdit,  // 編集権限
      canDelete: this.canDeleteUserInfo(user, currentUserEmail),  // 削除権限
      isLocked,
      isAdmin,
      isOwner
    };
  }

  /**
   * パスキーをハッシュ化
   * @private
   * @param {string} passkey パスキー
   * @returns {string} ハッシュ化されたパスキー
   */
  _hashPasskey(passkey) {
    return crypto
      .createHash(this.passkeyHashAlgorithm)
      .update(passkey, 'utf-8')
      .digest('hex');
  }

  /**
   * ランダムなパスキーを生成
   * @returns {string} 生成されたパスキー
   */
  generatePasskey() {
    return crypto
      .randomBytes(Math.ceil(this.passkeyLength / 2))
      .toString('hex')
      .slice(0, this.passkeyLength);
  }
}

module.exports = { UserProtectionService };
